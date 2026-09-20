import { describe, expect, it } from 'vitest';
import { ControllableProvider, FakeProvider, ManualClock, REDACTED, containsSecret, flushMicrotasks, redactRecord, redactString } from '../src';
import { makeHarness, record, texts } from './helpers';

const SECRET_KEY = 'sk-live-ABCDEF1234567890';

describe('AC7: safe operational trace', () => {
  it('redacts credentials that appear in provider error messages and never reads error side-channels', async () => {
    const provider = new ControllableProvider();
    const { runtime, store } = makeHarness({ provider });
    const handle = runtime.startTurn({ input: 'hello', conversationId: 'c1' });
    const error = Object.assign(new Error(`401 Unauthorized for key ${SECRET_KEY} (Authorization: Bearer abcdefgh12345678)`), {
      config: { headers: { Authorization: 'Bearer HEADER-SECRET-VALUE-999' } },
      cause: { apiKey: 'CAUSE-SECRET-VALUE-999' },
    });
    provider.fail(error);
    const summary = await handle.result;

    expect(summary.state).toBe('failed');
    const everything = JSON.stringify([store.getTrace(handle.runId), store.getRun(handle.runId), summary]);
    for (const leaked of [SECRET_KEY, 'abcdefgh12345678', 'HEADER-SECRET-VALUE-999', 'CAUSE-SECRET-VALUE-999']) {
      expect(everything).not.toContain(leaked);
    }
    expect(everything).toContain(REDACTED);
  });

  it('never streams, stores or traces hidden reasoning; only its size is recorded', async () => {
    const provider = new ControllableProvider();
    const { runtime, store } = makeHarness({ provider });
    const handle = runtime.startTurn({ input: 'hello', conversationId: 'c1' });
    const { events, done } = record(handle);
    provider.pushReasoning('SECRET-PLAN: first I will consider...');
    provider.push('visible answer');
    provider.end();
    const summary = await handle.result;
    await done;

    expect(summary).toMatchObject({ state: 'completed', output: 'visible answer' });
    expect(texts(events)).toEqual(['visible answer']);
    const dump = JSON.stringify([events, store.exportAll()]);
    expect(dump).not.toContain('SECRET-PLAN');
    const suppressed = store.getTrace(handle.runId).find((e) => e.type === 'provider.reasoning_suppressed');
    expect(suppressed?.data).toEqual({ chars: 'SECRET-PLAN: first I will consider...'.length });
  });

  it('explains contrasting outcomes with ordered, gapless events and nothing after the terminal event', async () => {
    const clock = new ManualClock(0);
    const outcomes: Array<[string, ConstructorParameters<typeof FakeProvider>[0], string]> = [
      ['ok', [{ text: 'a' }], 'completed'],
      ['boom', [{ text: 'a' }, { fail: 'boom' }], 'failed'],
    ];
    for (const [input, script, expected] of outcomes) {
      const { runtime, store } = makeHarness({ provider: new FakeProvider(script, clock), clock });
      const handle = runtime.startTurn({ input });
      const { events, done } = record(handle);
      await handle.result;
      await done;
      const trace = store.getTrace(handle.runId);
      const all = [...trace.map((e) => e.seq), ...store.getOutput(handle.runId).map((c) => c.seq)].sort((a, b) => a - b);
      expect(all).toEqual(all.map((_, i) => i + 1));
      expect(trace.at(-1)).toMatchObject({ type: 'run.terminal', data: { state: expected } });
      expect(events.map((e) => e.seq)).toEqual(all);
    }
  });

  it('does not persist a rejected input, even one that contains a credential', async () => {
    const clock = new ManualClock();
    const provider = new FakeProvider([{ text: 'x' }], clock);
    const { runtime, store } = makeHarness({ provider, clock });
    const summary = await runtime.runTurn({ input: `please use my key ${SECRET_KEY}`, conversationId: 'c1' });
    expect(summary).toMatchObject({ state: 'rejected', reasonCode: 'secret_in_input' });
    expect(JSON.stringify(store.exportAll())).not.toContain(SECRET_KEY);
    expect(provider.invokedRunIds).toEqual([]);
  });

  it('does not leak the run input into the trace', async () => {
    const clock = new ManualClock();
    const { runtime, store } = makeHarness({ provider: new FakeProvider([{ text: 'fine' }], clock), clock });
    const summary = await runtime.runTurn({ input: 'my private question about my landlord' });
    expect(JSON.stringify(store.getTrace(summary.runId))).not.toContain('landlord');
    await flushMicrotasks();
  });
});

describe('redaction helpers', () => {
  it('redacts by key name regardless of value', () => {
    expect(redactRecord({ apiKey: 'harmless', Authorization: 'x', count: 3, note: 'fine' })).toEqual({
      apiKey: REDACTED,
      Authorization: REDACTED,
      count: 3,
      note: 'fine',
    });
  });

  it('redacts by value shape inside free text', () => {
    expect(redactString(`failed with ${SECRET_KEY} and gsk_abcdefgh12345678`)).toBe(`failed with ${REDACTED} and ${REDACTED}`);
    expect(containsSecret('nothing to see here')).toBe(false);
    expect(containsSecret(`token=${'a'.repeat(10)}`)).toBe(true);
  });
});
