import { AsyncQueue } from './asyncQueue';
import type { Clock, TimerHandle } from './clock';
import type { Policy } from './policy';
import { createAbortError, parseChunk, type ModelProvider } from './provider';
import { redactRecord, safeErrorFields } from './redact';
import { RunStateMachine } from './stateMachine';
import type { RuntimeStore } from './store/store';
import type {
  ActiveState,
  CancelResult,
  PolicyDecision,
  ProviderChunk,
  RunSummary,
  RuntimeEvent,
  TerminalState,
  TextEvent,
  TraceData,
  TraceEntry,
  TraceEventType,
  TurnHandle,
} from './types';

const TERMINATED = Symbol('terminated');

export interface TurnDeps {
  provider: ModelProvider;
  policy: Policy;
  store: RuntimeStore;
  clock: Clock;
  /** Called for problems the turn cannot express as run state (e.g. the store failing while recording a terminal state). */
  onInternalError: (error: unknown) => void;
}

interface SettleInfo {
  reasonCode?: string;
  reason?: string;
  error?: unknown;
}

/**
 * Orchestrates exactly one turn. It owns ordering (one `seq` counter), the state machine,
 * cancellation, the timeout and the persistence boundary. Everything vendor-specific is
 * behind `ModelProvider`; everything storage-specific is behind `RuntimeStore`.
 *
 * Rule of thumb used throughout: `settle` is the only way to reach a terminal state, and it
 * is synchronous from "may I?" (state machine) to "done" (committed + published), so two
 * competing terminal attempts cannot interleave.
 */
export class TurnExecution {
  private readonly machine = new RunStateMachine();
  private readonly controller = new AbortController();
  private readonly queue = new AsyncQueue<RuntimeEvent>();
  private readonly parts: string[] = [];
  private seq = 0;
  private chunkCount = 0;
  private providerInvoked = false;
  private closed = false;
  private timer: TimerHandle | undefined;

  private resolveTerminated!: (value: typeof TERMINATED) => void;
  private readonly terminated = new Promise<typeof TERMINATED>((resolve) => {
    this.resolveTerminated = resolve;
  });
  private resolveResult!: (summary: RunSummary) => void;
  private readonly result = new Promise<RunSummary>((resolve) => {
    this.resolveResult = resolve;
  });

  constructor(
    private readonly deps: TurnDeps,
    private readonly runId: string,
    private readonly conversationId: string,
    private readonly input: string,
    private readonly timeoutMs: number,
  ) {}

  start(): TurnHandle {
    const { store, clock } = this.deps;
    store.createRun({
      id: this.runId,
      conversationId: this.conversationId,
      inputChars: this.input.length,
      timeoutMs: this.timeoutMs,
      at: clock.now(),
    });
    this.run().catch((error) => this.deps.onInternalError(error));
    return {
      runId: this.runId,
      events: this.queue,
      result: this.result,
      cancel: (reason) => this.cancel(reason),
    };
  }

  cancel(reason = 'Cancelled by caller'): CancelResult {
    const accepted = this.settle('cancelled', { reasonCode: 'user_cancelled', reason });
    return accepted ? { accepted: true } : { accepted: false, state: this.machine.state };
  }

  // ---------------------------------------------------------------- lifecycle

  private async run(): Promise<void> {
    try {
      await this.execute();
    } catch (error) {
      this.settle('failed', { reasonCode: 'internal_error', reason: 'Runtime error while executing the turn', error });
    }
  }

  private async execute(): Promise<void> {
    const { clock, store, policy } = this.deps;

    this.timer = clock.setTimeout(() => {
      try {
        this.settle('timed_out', { reasonCode: 'timeout', reason: `Turn exceeded ${this.timeoutMs}ms` });
      } catch (error) {
        this.deps.onInternalError(error);
      }
    }, this.timeoutMs);

    this.emitTrace('run.accepted', {
      conversationId: this.conversationId,
      inputChars: this.input.length,
      timeoutMs: this.timeoutMs,
    });

    if (!this.enter('checking_policy', () => store.setRunState(this.runId, 'created', 'checking_policy'))) return;

    let decision: PolicyDecision;
    try {
      decision = await policy.evaluate(this.input);
    } catch (error) {
      // Fail closed: a broken policy never means "allowed".
      this.settle('failed', { reasonCode: 'policy_error', reason: 'Policy check could not be evaluated', error });
      return;
    }
    if (this.machine.isTerminal) return; // cancelled or timed out while the policy was deciding

    this.emitTrace('policy.decision', decision.allowed ? { allowed: true } : { allowed: false, code: decision.code });
    if (!decision.allowed) {
      this.settle('rejected', { reasonCode: decision.code, reason: decision.reason });
      return;
    }

    const history = store
      .listMessages(this.conversationId)
      .map(({ role, content }) => ({ role, content }));

    const streaming = this.enter('streaming', () =>
      store.beginStreaming({
        runId: this.runId,
        userMessage: { id: `${this.runId}:user`, conversationId: this.conversationId, content: this.input, at: clock.now() },
      }),
    );
    if (!streaming) return;

    await this.consumeProvider(history);
  }

  // ------------------------------------------------------------ provider loop

  private async consumeProvider(history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>): Promise<void> {
    const iterator = this.openStream(history);
    if (!iterator) return;
    try {
      for (;;) {
        const pull = iterator.next();
        // If we stop waiting on this pull (terminal state won the race), its later rejection must not become an unhandled one.
        pull.catch(() => undefined);

        let step: IteratorResult<ProviderChunk>;
        try {
          const winner = await Promise.race([pull, this.terminated]);
          if (winner === TERMINATED) return; // stop consuming immediately, even if the provider ignores the abort signal
          step = winner;
        } catch (error) {
          this.failFromProvider(error);
          return;
        }

        if (this.machine.isTerminal) return; // a late event; never emitted, never persisted
        if (step.done) {
          this.settle('completed', {});
          return;
        }
        if (!this.acceptChunk(step.value)) return;
      }
    } finally {
      this.closeQuietly(iterator);
    }
  }

  private openStream(history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>): AsyncIterator<ProviderChunk> | undefined {
    try {
      this.emitTrace('provider.invoked', { provider: this.deps.provider.name });
      this.providerInvoked = true;
      return this.deps.provider
        .stream({ runId: this.runId, input: this.input, history, signal: this.controller.signal })
        [Symbol.asyncIterator]();
    } catch (error) {
      this.failFromProvider(error);
      return undefined;
    }
  }

  private closeQuietly(iterator: AsyncIterator<ProviderChunk>): void {
    // Fire and forget: a provider that hangs in return() must not be able to delay the run's outcome.
    void (async () => {
      try {
        await iterator.return?.();
      } catch {
        /* nothing useful to do */
      }
    })();
  }

  private failFromProvider(error: unknown): void {
    if (this.machine.isTerminal) return; // e.g. the AbortError caused by our own cancellation or timeout
    this.emitTrace('provider.error', safeErrorFields(error));
    this.settle('failed', { reasonCode: 'provider_error', reason: 'Provider stream failed', error });
  }

  /** Returns false when the run should stop consuming the provider. */
  private acceptChunk(raw: unknown): boolean {
    const chunk = parseChunk(raw);
    if (!chunk) {
      this.emitTrace('provider.error', {
        errorName: 'MalformedProviderEvent',
        errorMessage: 'Provider emitted an event outside the chunk contract',
      });
      this.settle('failed', { reasonCode: 'malformed_provider_event', reason: 'Provider emitted a malformed event' });
      return false;
    }
    if (chunk.type === 'reasoning') {
      // Hidden reasoning is dropped on the floor: only its size is recorded.
      this.emitTrace('provider.reasoning_suppressed', { chars: chunk.text.length });
      return true;
    }
    if (chunk.text.length === 0) return true;

    const index = this.chunkCount;
    this.emitTrace('provider.chunk', { index, chars: chunk.text.length });
    this.emitText(index, chunk.text);
    this.chunkCount += 1;
    this.parts.push(chunk.text);
    return true;
  }

  // -------------------------------------------------------------- transitions

  private enter(state: ActiveState, persist: () => void): boolean {
    const check = this.machine.check(state);
    if (!check.ok) {
      this.recordIgnored(state, check.reason);
      return false;
    }
    persist();
    this.machine.apply(state);
    this.emitTrace('state.changed', { from: check.from, to: state });
    return true;
  }

  /**
   * The only path to a terminal state.
   *  1. Ask the state machine (sync). If a terminal state already won, record the attempt and stop.
   *  2. Signal the provider to stop (non-success outcomes).
   *  3. Commit state + assistant message (completed only) + terminal trace entry atomically.
   *  4. Only then publish the terminal event and close the stream.
   */
  private settle(state: TerminalState, info: SettleInfo): boolean {
    const check = this.machine.check(state);
    if (!check.ok) {
      this.recordIgnored(state, check.reason);
      return false;
    }

    if (state !== 'completed') this.signalProviderAbort(state);

    const now = this.deps.clock.now();
    const assistantMessage =
      state === 'completed'
        ? { id: `${this.runId}:assistant`, conversationId: this.conversationId, content: this.parts.join(''), at: now }
        : undefined;

    const entry = this.makeEntry('run.terminal', {
      state,
      reasonCode: info.reasonCode ?? null,
      reason: info.reason ?? null,
      chunks: this.chunkCount,
      assistantMessageCommitted: assistantMessage !== undefined,
      ...(info.error === undefined ? {} : safeErrorFields(info.error)),
    });

    try {
      this.deps.store.finishRun({
        runId: this.runId,
        state,
        reasonCode: info.reasonCode ?? null,
        reason: info.reason ?? null,
        at: now,
        terminalEntry: entry,
        assistantMessage,
      });
    } catch (error) {
      if (state === 'completed') {
        // Never claim success that was not committed.
        return this.settle('failed', { reasonCode: 'persistence_error', reason: 'Completed output could not be committed', error });
      }
      this.deps.onInternalError(error);
    }

    this.machine.apply(state);
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer);
    this.publish(entry);
    this.closed = true;
    this.queue.close();
    this.resolveTerminated(TERMINATED);
    this.resolveResult({
      runId: this.runId,
      conversationId: this.conversationId,
      state,
      reasonCode: info.reasonCode ?? null,
      reason: info.reason ?? null,
      output: this.parts.join(''),
      chunkCount: this.chunkCount,
      assistantMessageCommitted: assistantMessage !== undefined,
    });
    return true;
  }

  private signalProviderAbort(cause: TerminalState): void {
    if (!this.providerInvoked || this.controller.signal.aborted) return;
    try {
      this.emitTrace('provider.abort_signaled', { cause });
    } catch (error) {
      this.deps.onInternalError(error);
    }
    this.controller.abort(createAbortError(`run ${cause}`));
  }

  private recordIgnored(attempted: string, reason: string): void {
    try {
      this.deps.store.recordIgnored(this.runId, { at: this.deps.clock.now(), attempted, reason });
    } catch (error) {
      this.deps.onInternalError(error);
    }
  }

  // ------------------------------------------------------------------ events

  private makeEntry(type: TraceEventType, data: TraceData): TraceEntry {
    return { runId: this.runId, seq: this.seq + 1, at: this.deps.clock.now(), type, data: redactRecord(data) };
  }

  private publish(event: RuntimeEvent): void {
    this.seq = event.seq;
    if (!this.closed) this.queue.push(event);
  }

  private emitTrace(type: TraceEventType, data: TraceData): void {
    if (this.closed || this.machine.isTerminal) return; // nothing is ever recorded after the terminal event
    const entry = this.makeEntry(type, data);
    this.deps.store.appendTrace(entry);
    this.publish(entry);
  }

  private emitText(index: number, text: string): void {
    if (this.closed || this.machine.isTerminal) return;
    const event: TextEvent = { runId: this.runId, seq: this.seq + 1, at: this.deps.clock.now(), type: 'text.delta', index, text };
    this.deps.store.appendOutput({ runId: this.runId, seq: event.seq, index, text });
    this.publish(event);
  }
}
