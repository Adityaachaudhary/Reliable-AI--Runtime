import type { RunState, TraceEntry } from '../types';

export interface StoredMessage {
  id: string;
  conversationId: string;
  runId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface IgnoredSignal {
  at: number;
  attempted: string;
  reason: string;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  state: RunState;
  reasonCode: string | null;
  reason: string | null;
  /** Only the length of the input is kept on the run; content lives in `messages` and only if accepted. */
  inputChars: number;
  timeoutMs: number;
  createdAt: number;
  endedAt: number | null;
  ignoredSignals: IgnoredSignal[];
}

export interface OutputChunk {
  seq: number;
  index: number;
  text: string;
}

export interface FinishRunInput {
  runId: string;
  state: Exclude<RunState, 'created' | 'checking_policy' | 'streaming'>;
  reasonCode: string | null;
  reason: string | null;
  at: number;
  terminalEntry: TraceEntry;
  /** Present only for `completed`. Written in the same transaction as the state change. */
  assistantMessage?: { id: string; conversationId: string; content: string; at: number };
}

/**
 * Persistence boundary. Synchronous on purpose (see SUBMISSION.md): a terminal outcome, its
 * assistant message and its terminal trace entry commit atomically or not at all.
 */
export interface RuntimeStore {
  createRun(run: { id: string; conversationId: string; inputChars: number; timeoutMs: number; at: number }): void;
  /** Non-terminal transition; throws if the stored state is not `from`. */
  setRunState(runId: string, from: RunState, to: RunState): void;
  /** checking_policy -> streaming, and the accepted user message, in one transaction. */
  beginStreaming(input: {
    runId: string;
    userMessage: { id: string; conversationId: string; content: string; at: number };
  }): void;
  appendTrace(entry: TraceEntry): void;
  appendOutput(chunk: { runId: string; seq: number; index: number; text: string }): void;
  /** Atomic terminal commit. Throws if the run is already terminal in storage. */
  finishRun(input: FinishRunInput): void;
  recordIgnored(runId: string, signal: IgnoredSignal): void;
  /** Marks every run left non-terminal (e.g. by a crash) as failed/interrupted. Returns their ids. */
  recoverInterruptedRuns(at: number): string[];

  getRun(runId: string): RunRecord | undefined;
  listRuns(limit?: number): RunRecord[];
  getTrace(runId: string): TraceEntry[];
  getOutput(runId: string): OutputChunk[];
  listMessages(conversationId: string): StoredMessage[];
  listRunMessages(runId: string): StoredMessage[];
  close(): void;
}
