/**
 * Shared vocabulary for the runtime.
 *
 * A turn (a "run") moves through ACTIVE states and ends in exactly one TERMINAL state.
 * Only `completed` is a success; every other terminal state is an honest non-success.
 */
export const TERMINAL_STATES = ['completed', 'rejected', 'cancelled', 'timed_out', 'failed'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];
export type ActiveState = 'created' | 'checking_policy' | 'streaming';
export type RunState = ActiveState | TerminalState;

/** Result of the pre-response policy gate. `reason` is static text and never echoes the input. */
export type PolicyDecision = { allowed: true } | { allowed: false; code: string; reason: string };

/**
 * What a provider may emit. `reasoning` chunks model providers that expose hidden reasoning;
 * the runtime consumes them but never forwards, stores or traces their content.
 */
export type ProviderChunk = { type: 'text'; text: string } | { type: 'reasoning'; text: string };

/** Trace payloads are flat primitives on purpose: nothing nested can smuggle a secret in. */
export type TraceData = Record<string, string | number | boolean | null>;

export type TraceEventType =
  | 'run.accepted'
  | 'policy.decision'
  | 'state.changed'
  | 'provider.invoked'
  | 'provider.chunk'
  | 'provider.reasoning_suppressed'
  | 'provider.error'
  | 'provider.abort_signaled'
  | 'run.terminal';

/** Operational event. Never contains model text or reasoning. */
export interface TraceEntry {
  runId: string;
  /** Per-run, gapless, starts at 1. Shared with text events so the merged timeline is totally ordered. */
  seq: number;
  at: number;
  type: TraceEventType;
  data: TraceData;
}

/** A streamed piece of assistant text (the user-visible output). */
export interface TextEvent {
  runId: string;
  seq: number;
  at: number;
  type: 'text.delta';
  index: number;
  text: string;
}

export type RuntimeEvent = TraceEntry | TextEvent;

export interface RunSummary {
  runId: string;
  conversationId: string;
  state: TerminalState;
  reasonCode: string | null;
  reason: string | null;
  /** Everything streamed to the client. For non-completed runs this is partial output, never a committed reply. */
  output: string;
  chunkCount: number;
  /** True only for `completed`. */
  assistantMessageCommitted: boolean;
}

export type CancelResult = { accepted: true } | { accepted: false; state: RunState };

export interface TurnRequest {
  input: string;
  conversationId?: string;
  timeoutMs?: number;
}

export interface TurnHandle {
  readonly runId: string;
  /** Ordered events; the iterator ends right after the terminal event. */
  readonly events: AsyncIterable<RuntimeEvent>;
  /** Resolves (never rejects) once a terminal state has been committed. */
  readonly result: Promise<RunSummary>;
  cancel(reason?: string): CancelResult;
}
