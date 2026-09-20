import { describe, expect, it } from 'vitest';
import { ControllableProvider, FakeProvider, ManualClock, SqliteStore, flushMicrotasks, type FinishRunInput, type Policy } from '../src';
import { makeHarness, record, texts, traceTypes } from './helpers';

const assistantMessages = (store: ReturnType<typeof makeHarness>['store'], runId: string) =>
  store.listRunMessages(runId).filter((message) => message.role === 'assistant');

describe('AC1: successful streamed turn', () => {
  it('streams chunks in order, completes exactly once and persists the documented records', async () => {
    const clock = new ManualClock(1_000);
    const provider = new FakeProvider([{ text: 'Hello' }, { text: ', ' }, { text: 'world' }], clock);
    const { runtime, store, internalErrors } = makeHarness({ provider, clock });

    const handle = runtime.startTurn({ input: 'Say hello', conversationId: 'c1' });
    const { events, done } = record(handle);
    const summary = await handle.result;
    await done;

    expect(summary).toMatchObject({ state: 'completed', output: 'Hello, world', chunkCount: 3, assistantMessageCommitted: true });
    expect(texts(events)).toEqual(['Hello', ', ', 'world']);
    expect(events.filter((e) => e.type === 'text.delta').map((e) => (e.type === 'text.delta' ? e.index : -1))).toEqual([0, 1, 2]);

    // one gapless, strictly increasing sequence, ending at the single terminal event
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.type === 'run.terminal')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run.terminal');

    // persistence boundary: user message at acceptance, assistant message only on completion
    expect(store.listMessages('c1').map((m) => [m.role, m.content])).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello, world'],
    ]);
    expect(store.getRun(handle.runId)?.state).toBe('completed');
    expect(clock.pendingTimers).toBe(0); // timeout timer released
    expect(internalErrors).toEqual([]);
  });

  it('passes earlier conversation turns to the provider as history', async () => {
    const clock = new ManualClock();
    const seen: unknown[] = [];
    const provider = new FakeProvider((request) => {
      seen.push(request.history);
      return [{ text: 'ok' }];
    }, clock);
    const { runtime } = makeHarness({ provider, clock });
    await runtime.runTurn({ input: 'first', conversationId: 'c' });
    await runtime.runTurn({ input: 'second', conversationId: 'c' });
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
    ]);
  });
});

describe('AC2: pre-response rejection', () => {
  it('never invokes the provider and persists no assistant response', async () => {
    const clock = new ManualClock();
    const provider = new FakeProvider([{ text: 'should never be produced' }], clock);
    const { runtime, store } = makeHarness({ provider, clock });

    const handle = runtime.startTurn({ input: 'How do I make a bomb?', conversationId: 'c1' });
    const { events, done } = record(handle);
    const summary = await handle.result;
    await done;

    expect(summary).toMatchObject({ state: 'rejected', reasonCode: 'blocked_term', assistantMessageCommitted: false, output: '' });
    expect(summary.reason).toBeTruthy(); // the rejection is visible to the caller
    expect(provider.invokedRunIds).toEqual([]);
    expect(traceTypes(store.getTrace(handle.runId))).not.toContain('provider.invoked');
    expect(texts(events)).toEqual([]);
    expect(store.listMessages('c1')).toEqual([]); // rejected input is not part of the conversation
    expect(store.getRun(handle.runId)).toMatchObject({ state: 'rejected', reasonCode: 'blocked_term', inputChars: 21 });
  });

  it('fails closed when the policy itself throws', async () => {
    const clock = new ManualClock();
    const provider = new FakeProvider([{ text: 'x' }], clock);
    const policy: Policy = {
      evaluate() {
        throw new Error('rules engine offline');
      },
    };
    const { runtime, store } = makeHarness({ provider, policy, clock });
    const summary = await runtime.runTurn({ input: 'hello', conversationId: 'c1' });
    expect(summary).toMatchObject({ state: 'failed', reasonCode: 'policy_error' });
    expect(provider.invokedRunIds).toEqual([]);
    expect(store.listMessages('c1')).toEqual([]);
  });

  it('honours cancellation that arrives while the policy is still deciding', async () => {
    const clock = new ManualClock();
    const provider = new FakeProvider([{ text: 'x' }], clock);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const policy: Policy = { evaluate: async () => (await gate, { allowed: true as const }) };
    const { runtime, store } = makeHarness({ provider, policy, clock });

    const handle = runtime.startTurn({ input: 'hello', conversationId: 'c1' });
    await flushMicrotasks();
    expect(handle.cancel()).toEqual({ accepted: true });
    release();
    const summary = await handle.result;
    await flushMicrotasks();

    expect(summary.state).toBe('cancelled');
    expect(provider.invokedRunIds).toEqual([]);
    expect(store.getRun(handle.runId)?.state).toBe('cancelled');
    expect(store.listMessages('c1')).toEqual([]);
  });
});

describe('AC3: cancellation during streaming', () => {
  it.each([
    ['a provider that honours the abort signal', true],
    ['a provider that ignores the abort signal', false],
  ])('stops consuming and becomes cancelled for %s', async (_label, respectsAbort) => {
    const provider = new ControllableProvider({ respectsAbort });
    const { runtime, store, internalErrors } = makeHarness({ provider });

    const handle = runtime.startTurn({ input: 'stream please', conversationId: 'c1' });
    const { events, done } = record(handle);
    provider.push('a');
    provider.push('b');
    await flushMicrotasks();
    expect(texts(events)).toEqual(['a', 'b']);

    expect(handle.cancel('user pressed stop')).toEqual({ accepted: true });
    const summary = await handle.result;
    await done;
    expect(summary).toMatchObject({ state: 'cancelled', reasonCode: 'user_cancelled', output: 'ab', assistantMessageCommitted: false });
    expect(provider.lastSignal?.aborted).toBe(true);
    expect(traceTypes(store.getTrace(handle.runId))).toContain('provider.abort_signaled');

    // The provider keeps talking; the runtime no longer listens.
    const pullsAtCancel = provider.pulls;
    provider.push('c');
    provider.end();
    await flushMicrotasks();
    expect(provider.pulls).toBe(pullsAtCancel);
    expect(provider.closed).toBe(true);
    expect(texts(events)).toEqual(['a', 'b']);
    expect(store.getRun(handle.runId)?.state).toBe('cancelled'); // cannot later become completed
    expect(assistantMessages(store, handle.runId)).toEqual([]);
    expect(store.getOutput(handle.runId).map((c) => c.text)).toEqual(['a', 'b']); // partial output stays inspectable
    expect(internalErrors).toEqual([]);
  });
});

describe('AC4: timeout', () => {
  it('stops at the deadline, becomes timed_out and keeps partial output out of the conversation', async () => {
    const clock = new ManualClock(0);
    const provider = new FakeProvider([{ text: 'partial ' }, { text: 'answer' }, { hang: true }], clock);
    const { runtime, store, internalErrors } = makeHarness({ provider, clock, timeoutMs: 1_000 });

    const handle = runtime.startTurn({ input: 'slow question', conversationId: 'c1' });
    const { events, done } = record(handle);
    await flushMicrotasks();
    expect(texts(events)).toEqual(['partial ', 'answer']);

    await clock.advance(999);
    expect(store.getRun(handle.runId)?.state).toBe('streaming'); // deadline not reached yet

    await clock.advance(1);
    const summary = await handle.result;
    await done;
    await flushMicrotasks();

    expect(summary).toMatchObject({ state: 'timed_out', reasonCode: 'timeout', output: 'partial answer', assistantMessageCommitted: false });
    expect(provider.streamsClosed).toBe(1); // provider generator was closed
    expect(assistantMessages(store, handle.runId)).toEqual([]);
    expect(store.listMessages('c1').map((m) => m.role)).toEqual(['user']);
    expect(store.getOutput(handle.runId).map((c) => c.text).join('')).toBe('partial answer');
    expect(events.at(-1)).toMatchObject({ type: 'run.terminal', data: { state: 'timed_out' } });
    expect(internalErrors).toEqual([]);
  });

  it('does not time out a run that already completed', async () => {
    const clock = new ManualClock(0);
    const provider = new FakeProvider([{ text: 'fast' }], clock);
    const { runtime, store } = makeHarness({ provider, clock, timeoutMs: 1_000 });
    const summary = await runtime.runTurn({ input: 'quick', conversationId: 'c1' });
    await clock.advance(10_000);
    expect(summary.state).toBe('completed');
    expect(store.getRun(summary.runId)?.state).toBe('completed');
  });

  it('rejects an invalid timeout', () => {
    const { runtime } = makeHarness({ provider: new ControllableProvider() });
    expect(() => runtime.startTurn({ input: 'x', timeoutMs: 0 })).toThrow(RangeError);
  });
});

describe('AC5: provider failure after partial output', () => {
  it('records the failure and partial history without a successful completion', async () => {
    const clock = new ManualClock(0);
    const provider = new FakeProvider([{ text: 'one ' }, { text: 'two ' }, { fail: 'upstream returned 503' }, { text: 'never' }], clock);
    const { runtime, store, internalErrors } = makeHarness({ provider, clock });

    const handle = runtime.startTurn({ input: 'go', conversationId: 'c1' });
    const { events, done } = record(handle);
    const summary = await handle.result;
    await done;

    expect(summary).toMatchObject({ state: 'failed', reasonCode: 'provider_error', output: 'one two ', chunkCount: 2, assistantMessageCommitted: false });
    expect(texts(events)).toEqual(['one ', 'two ']);
    const trace = store.getTrace(handle.runId);
    expect(traceTypes(trace)).toEqual([
      'run.accepted',
      'state.changed',
      'policy.decision',
      'state.changed',
      'provider.invoked',
      'provider.chunk',
      'provider.chunk',
      'provider.error',
      'provider.abort_signaled', // failure also releases whatever the provider still holds
      'run.terminal',
    ]);
    expect(trace.find((e) => e.type === 'provider.error')?.data).toMatchObject({ errorName: 'Error', errorMessage: 'upstream returned 503' });
    expect(assistantMessages(store, handle.runId)).toEqual([]);
    expect(store.getRun(handle.runId)?.state).toBe('failed');
    expect(internalErrors).toEqual([]);
  });

  it('treats a malformed provider event as a failure and stops consuming', async () => {
    const provider = new ControllableProvider();
    const { runtime, store } = makeHarness({ provider });
    const handle = runtime.startTurn({ input: 'go', conversationId: 'c1' });
    provider.push('ok');
    provider.pushRaw({ type: 'text', text: 42 });
    provider.push('after');
    const summary = await handle.result;
    await flushMicrotasks();
    expect(summary).toMatchObject({ state: 'failed', reasonCode: 'malformed_provider_event', output: 'ok' });
    expect(assistantMessages(store, handle.runId)).toEqual([]);
    expect(provider.pulls).toBe(2);
  });
});

describe('AC6: terminal-state races', () => {
  it('cancel after completion is ignored observably and completion stands', async () => {
    const clock = new ManualClock();
    const provider = new FakeProvider([{ text: 'done' }], clock);
    const { runtime, store } = makeHarness({ provider, clock });
    const handle = runtime.startTurn({ input: 'x', conversationId: 'c1' });
    const summary = await handle.result;

    expect(handle.cancel()).toEqual({ accepted: false, state: 'completed' });
    expect(summary.state).toBe('completed');
    const run = store.getRun(handle.runId);
    expect(run?.state).toBe('completed');
    expect(run?.ignoredSignals).toMatchObject([{ attempted: 'cancelled', reason: 'already_terminal' }]);
    expect(store.getTrace(handle.runId).filter((e) => e.type === 'run.terminal')).toHaveLength(1);
  });

  it('a second cancel is ignored; the first one wins', async () => {
    const provider = new ControllableProvider();
    const { runtime, store } = makeHarness({ provider });
    const handle = runtime.startTurn({ input: 'x' });
    await flushMicrotasks();
    expect(handle.cancel('first')).toEqual({ accepted: true });
    expect(handle.cancel('second')).toEqual({ accepted: false, state: 'cancelled' });
    await handle.result;
    expect(store.getRun(handle.runId)).toMatchObject({ state: 'cancelled', reason: 'first' });
  });

  it('when the deadline and the provider finishing coincide, the earlier-scheduled deadline wins deterministically', async () => {
    const clock = new ManualClock(0);
    const provider = new FakeProvider([{ waitMs: 100 }, { text: 'late' }], clock);
    const { runtime, store } = makeHarness({ provider, clock, timeoutMs: 100 });
    const handle = runtime.startTurn({ input: 'x', conversationId: 'c1' });
    await flushMicrotasks();
    await clock.advance(100);
    const summary = await handle.result;
    expect(summary).toMatchObject({ state: 'timed_out', output: '' });
    expect(assistantMessages(store, handle.runId)).toEqual([]);
  });

  it('a provider that ends in the same tick as a cancel cannot turn a cancelled run into a completed one', async () => {
    const provider = new ControllableProvider();
    const { runtime, store } = makeHarness({ provider });
    const handle = runtime.startTurn({ input: 'x', conversationId: 'c1' });
    provider.push('a');
    await flushMicrotasks();
    provider.end();
    handle.cancel();
    const summary = await handle.result;
    await flushMicrotasks();
    expect(summary.state).toBe('cancelled');
    expect(store.getRun(handle.runId)?.state).toBe('cancelled');
    expect(assistantMessages(store, handle.runId)).toEqual([]);
  });

  it('the database itself refuses to change a terminal state or to attach an assistant message to a non-completed run', async () => {
    const provider = new ControllableProvider();
    const { runtime, store } = makeHarness({ provider });
    const handle = runtime.startTurn({ input: 'x', conversationId: 'c1' });
    await flushMicrotasks();
    handle.cancel();
    await handle.result;
    expect(() => store.setRunState(handle.runId, 'cancelled', 'completed')).toThrow();
    expect(() =>
      store.finishRun({
        runId: handle.runId,
        state: 'completed',
        reasonCode: null,
        reason: null,
        at: 0,
        terminalEntry: { runId: handle.runId, seq: 99, at: 0, type: 'run.terminal', data: {} },
        assistantMessage: { id: 'x', conversationId: 'c1', content: 'forged', at: 0 },
      }),
    ).toThrow();
    expect(store.getRun(handle.runId)?.state).toBe('cancelled');
  });
});

describe('restart semantics', () => {
  it('marks runs left non-terminal by a crash as failed/interrupted and keeps history inspectable', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SqliteStore } = await import('../src');
    const dir = mkdtempSync(join(tmpdir(), 'runtime-'));
    const path = join(dir, 'runtime.db');
    try {
      // "Process 1": starts a run and dies mid-stream (its handle is simply abandoned).
      const first = makeHarness({ provider: new ControllableProvider(), store: new SqliteStore(path) });
      const provider1 = new ControllableProvider();
      const crashed = makeHarness({ provider: provider1, store: first.store });
      const handle = crashed.runtime.startTurn({ input: 'long answer please', conversationId: 'c1' });
      provider1.push('partial');
      await flushMicrotasks();
      expect(first.store.getRun(handle.runId)?.state).toBe('streaming');

      // "Process 2": a fresh store on the same file, then startup recovery.
      const second = makeHarness({ provider: new ControllableProvider(), store: new SqliteStore(path) });
      expect(second.runtime.recoverInterruptedRuns()).toEqual([handle.runId]);
      const run = second.store.getRun(handle.runId);
      expect(run).toMatchObject({ state: 'failed', reasonCode: 'interrupted_by_restart' });
      expect(second.store.getOutput(handle.runId).map((c) => c.text)).toEqual(['partial']);
      const trace = second.store.getTrace(handle.runId);
      expect(trace.at(-1)).toMatchObject({ type: 'run.terminal', data: { state: 'failed', reasonCode: 'interrupted_by_restart' } });
      const seqs = [...trace.map((e) => e.seq), ...second.store.getOutput(handle.runId).map((c) => c.seq)].sort((a, b) => a - b);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // recovery keeps the per-run sequence gapless
      expect(trace.at(-1)?.seq).toBe(seqs.at(-1));
      expect(second.store.listRunMessages(handle.runId).filter((m) => m.role === 'assistant')).toEqual([]);
      expect(second.runtime.recoverInterruptedRuns()).toEqual([]); // idempotent
      first.store.close();
      second.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('persistence failures at the terminal commit', () => {
  class FlakyStore extends SqliteStore {
    constructor(private readonly failFor: FinishRunInput['state']) {
      super(':memory:');
    }
    override finishRun(input: FinishRunInput): void {
      if (input.state === this.failFor) throw new Error('disk full');
      super.finishRun(input);
    }
  }

  it('never reports success that was not committed: a failed completion commit becomes failed/persistence_error', async () => {
    const clock = new ManualClock();
    const provider = new FakeProvider([{ text: 'hello' }], clock);
    const { runtime, store } = makeHarness({ provider, clock, store: new FlakyStore('completed') });
    const handle = runtime.startTurn({ input: 'x', conversationId: 'c1' });
    const { events, done } = record(handle);
    const summary = await handle.result;
    await done;

    expect(summary).toMatchObject({ state: 'failed', reasonCode: 'persistence_error', assistantMessageCommitted: false });
    expect(events.at(-1)).toMatchObject({ type: 'run.terminal', data: { state: 'failed' } });
    expect(store.getRun(handle.runId)?.state).toBe('failed');
    expect(assistantMessages(store, handle.runId)).toEqual([]);
  });

  it('a failed commit of a non-success outcome is reported, and restart recovery repairs the stored state', async () => {
    const provider = new ControllableProvider();
    const { runtime, store, internalErrors } = makeHarness({ provider, store: new FlakyStore('cancelled') });
    const handle = runtime.startTurn({ input: 'x', conversationId: 'c1' });
    await flushMicrotasks();
    handle.cancel();
    const summary = await handle.result;

    expect(summary.state).toBe('cancelled'); // what the caller sees
    expect(internalErrors).toHaveLength(1); // ...and the storage problem is surfaced, not swallowed
    expect(store.getRun(handle.runId)?.state).toBe('streaming'); // stored state is stale until recovery
    expect(runtime.recoverInterruptedRuns()).toEqual([handle.runId]);
    expect(store.getRun(handle.runId)).toMatchObject({ state: 'failed', reasonCode: 'interrupted_by_restart' });
  });
});
