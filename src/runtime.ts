import { systemClock, type Clock } from './clock';
import { RulePolicy, type Policy } from './policy';
import type { ModelProvider } from './provider';
import type { OutputChunk, RunRecord, RuntimeStore, StoredMessage } from './store/store';
import { TurnExecution } from './turn';
import type { RunSummary, TraceEntry, TurnHandle, TurnRequest } from './types';
import { randomUUID } from 'node:crypto';

export interface RuntimeOptions {
  provider: ModelProvider;
  store: RuntimeStore;
  policy?: Policy;
  clock?: Clock;
  /** Run id generator. Injectable so tests and the benchmark are deterministic. */
  ids?: () => string;
  defaultTimeoutMs?: number;
  onInternalError?: (error: unknown) => void;
}

/**
 * Thin facade. It wires dependencies, validates requests and exposes read access to what was
 * persisted. Orchestration lives in `TurnExecution`; storage in `RuntimeStore`.
 */
export class ConversationRuntime {
  private readonly policy: Policy;
  private readonly clock: Clock;
  private readonly ids: () => string;
  private readonly defaultTimeoutMs: number;
  private readonly onInternalError: (error: unknown) => void;

  constructor(private readonly options: RuntimeOptions) {
    this.policy = options.policy ?? new RulePolicy();
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomUUID;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.onInternalError = options.onInternalError ?? ((error) => console.error('[runtime] internal error', error));
  }

  startTurn(request: TurnRequest): TurnHandle {
    if (typeof request.input !== 'string') throw new TypeError('input must be a string');
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be a positive number');

    const turn = new TurnExecution(
      {
        provider: this.options.provider,
        policy: this.policy,
        store: this.options.store,
        clock: this.clock,
        onInternalError: this.onInternalError,
      },
      this.ids(),
      request.conversationId ?? 'default',
      request.input,
      timeoutMs,
    );
    return turn.start();
  }

  /** Convenience for callers that do not need the stream. */
  runTurn(request: TurnRequest): Promise<RunSummary> {
    return this.startTurn(request).result;
  }

  /**
   * Restart semantics: an in-flight generator does not survive a process restart, so any run left
   * non-terminal is marked failed/`interrupted_by_restart`. Call once at startup.
   */
  recoverInterruptedRuns(): string[] {
    return this.options.store.recoverInterruptedRuns(this.clock.now());
  }

  getRun(runId: string): RunRecord | undefined {
    return this.options.store.getRun(runId);
  }

  getTrace(runId: string): TraceEntry[] {
    return this.options.store.getTrace(runId);
  }

  getOutput(runId: string): OutputChunk[] {
    return this.options.store.getOutput(runId);
  }

  getMessages(conversationId: string): StoredMessage[] {
    return this.options.store.listMessages(conversationId);
  }
}
