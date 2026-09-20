import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { RunState, TraceData, TraceEntry, TraceEventType } from '../types';
import type {
  FinishRunInput,
  IgnoredSignal,
  OutputChunk,
  RunRecord,
  RuntimeStore,
  StoredMessage,
} from './store';

/**
 * Uses Node's built-in SQLite (`node:sqlite`, Node 22.13+): no native dependency to compile or download.
 * It is loaded through `createRequire` so bundlers/test runners do not need to know the module,
 * and the one-line "experimental" warning older Node versions print is silenced.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite')) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } catch (error) {
    throw new Error('This project needs Node.js 22.13 or newer (built-in node:sqlite). Run `node -v` to check.', { cause: error });
  } finally {
    process.emitWarning = original;
  }
}

const ACTIVE = `('created','checking_policy','streaming')`;
const TERMINAL = `('completed','rejected','cancelled','timed_out','failed')`;

/**
 * Besides the application-level state machine, the schema enforces the two rules that matter
 * most, so a bug (or a zombie writer) cannot violate them:
 *   1. a terminal run state is final;
 *   2. an assistant message can only exist for a `completed` run.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('created','checking_policy','streaming','completed','rejected','cancelled','timed_out','failed')),
  reason_code TEXT,
  reason TEXT,
  input_chars INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS one_assistant_message_per_run ON messages(run_id) WHERE role = 'assistant';

CREATE TABLE IF NOT EXISTS run_trace (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS run_output (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS ignored_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at INTEGER NOT NULL,
  attempted TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS runs_terminal_state_is_final
BEFORE UPDATE OF state ON runs
WHEN OLD.state IN ${TERMINAL}
BEGIN
  SELECT RAISE(ABORT, 'terminal run state is final');
END;

CREATE TRIGGER IF NOT EXISTS assistant_message_requires_completed_run
BEFORE INSERT ON messages
WHEN NEW.role = 'assistant' AND (SELECT state FROM runs WHERE id = NEW.run_id) IS NOT 'completed'
BEGIN
  SELECT RAISE(ABORT, 'assistant message requires a completed run');
END;
`;

interface RunRow {
  id: string;
  conversation_id: string;
  state: RunState;
  reason_code: string | null;
  reason: string | null;
  input_chars: number;
  timeout_ms: number;
  created_at: number;
  ended_at: number | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  run_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

export class SqliteStore implements RuntimeStore {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    const { DatabaseSync: Database } = loadSqlite();
    this.db = new Database(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /** BEGIN IMMEDIATE ... COMMIT, rolled back on any error (including schema-trigger aborts). */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createRun(run: { id: string; conversationId: string; inputChars: number; timeoutMs: number; at: number }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, conversation_id, state, input_chars, timeout_ms, created_at)
         VALUES (?, ?, 'created', ?, ?, ?)`,
      )
      .run(run.id, run.conversationId, run.inputChars, run.timeoutMs, run.at);
  }

  setRunState(runId: string, from: RunState, to: RunState): void {
    const result = this.db.prepare(`UPDATE runs SET state = ? WHERE id = ? AND state = ?`).run(to, runId, from);
    if (result.changes !== 1) throw new Error(`run ${runId} is not in state ${from}`);
  }

  beginStreaming(input: {
    runId: string;
    userMessage: { id: string; conversationId: string; content: string; at: number };
  }): void {
    this.transaction(() => {
      this.setRunState(input.runId, 'checking_policy', 'streaming');
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, run_id, role, content, created_at)
           VALUES (?, ?, ?, 'user', ?, ?)`,
        )
        .run(input.userMessage.id, input.userMessage.conversationId, input.runId, input.userMessage.content, input.userMessage.at);
    });
  }

  appendTrace(entry: TraceEntry): void {
    this.db
      .prepare(`INSERT INTO run_trace (run_id, seq, at, type, data) VALUES (?, ?, ?, ?, ?)`)
      .run(entry.runId, entry.seq, entry.at, entry.type, JSON.stringify(entry.data));
  }

  appendOutput(chunk: { runId: string; seq: number; index: number; text: string }): void {
    this.db
      .prepare(`INSERT INTO run_output (run_id, seq, chunk_index, text) VALUES (?, ?, ?, ?)`)
      .run(chunk.runId, chunk.seq, chunk.index, chunk.text);
  }

  finishRun(input: FinishRunInput): void {
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE runs SET state = ?, reason_code = ?, reason = ?, ended_at = ?
           WHERE id = ? AND state IN ${ACTIVE}`,
        )
        .run(input.state, input.reasonCode, input.reason, input.at, input.runId);
      if (result.changes !== 1) throw new Error(`run ${input.runId} is not active in storage`);
      if (input.assistantMessage) {
        const message = input.assistantMessage;
        this.db
          .prepare(
            `INSERT INTO messages (id, conversation_id, run_id, role, content, created_at)
             VALUES (?, ?, ?, 'assistant', ?, ?)`,
          )
          .run(message.id, message.conversationId, input.runId, message.content, message.at);
      }
      this.appendTrace(input.terminalEntry);
    });
  }

  recordIgnored(runId: string, signal: IgnoredSignal): void {
    this.db
      .prepare(`INSERT INTO ignored_signals (run_id, at, attempted, reason) VALUES (?, ?, ?, ?)`)
      .run(runId, signal.at, signal.attempted, signal.reason);
  }

  recoverInterruptedRuns(at: number): string[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM runs WHERE state IN ${ACTIVE} ORDER BY created_at, id`).all() as unknown as Array<{
        id: string;
      }>;
      for (const { id } of rows) {
        const seqRow = this.db
          .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM (SELECT seq FROM run_trace WHERE run_id = ? UNION ALL SELECT seq FROM run_output WHERE run_id = ?)`)
          .get(id, id) as unknown as { next: number };
        const data: TraceData = {
          state: 'failed',
          reasonCode: 'interrupted_by_restart',
          reason: 'Process stopped before the run reached a terminal state',
          assistantMessageCommitted: false,
        };
        this.db
          .prepare(`UPDATE runs SET state = 'failed', reason_code = ?, reason = ?, ended_at = ? WHERE id = ?`)
          .run('interrupted_by_restart', String(data.reason), at, id);
        this.appendTrace({ runId: id, seq: seqRow.next, at, type: 'run.terminal', data });
      }
      return rows.map((row) => row.id);
    });
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as unknown as RunRow | undefined;
    return row ? this.toRunRecord(row) : undefined;
  }

  listRuns(limit = 50): RunRecord[] {
    const rows = this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit) as unknown as RunRow[];
    return rows.map((row) => this.toRunRecord(row));
  }

  getTrace(runId: string): TraceEntry[] {
    const rows = this.db
      .prepare(`SELECT run_id, seq, at, type, data FROM run_trace WHERE run_id = ? ORDER BY seq`)
      .all(runId) as unknown as Array<{ run_id: string; seq: number; at: number; type: string; data: string }>;
    return rows.map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      at: row.at,
      type: row.type as TraceEventType,
      data: JSON.parse(row.data) as TraceData,
    }));
  }

  getOutput(runId: string): OutputChunk[] {
    const rows = this.db
      .prepare(`SELECT seq, chunk_index, text FROM run_output WHERE run_id = ? ORDER BY seq`)
      .all(runId) as unknown as Array<{ seq: number; chunk_index: number; text: string }>;
    return rows.map((row) => ({ seq: row.seq, index: row.chunk_index, text: row.text }));
  }

  listMessages(conversationId: string): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid`)
      .all(conversationId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  listRunMessages(runId: string): StoredMessage[] {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE run_id = ? ORDER BY rowid`).all(runId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** Inspection helper: every stored row, used by tests to prove that certain text was never persisted. */
  exportAll(): Record<string, unknown[]> {
    const tables = ['runs', 'messages', 'run_trace', 'run_output', 'ignored_signals'];
    return Object.fromEntries(tables.map((table) => [table, this.db.prepare(`SELECT * FROM ${table}`).all() as unknown[]]));
  }

  close(): void {
    this.db.close();
  }

  private toRunRecord(row: RunRow): RunRecord {
    const ignored = this.db
      .prepare(`SELECT at, attempted, reason FROM ignored_signals WHERE run_id = ? ORDER BY id`)
      .all(row.id) as unknown as IgnoredSignal[];
    return {
      id: row.id,
      conversationId: row.conversation_id,
      state: row.state,
      reasonCode: row.reason_code,
      reason: row.reason,
      inputChars: row.input_chars,
      timeoutMs: row.timeout_ms,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      ignoredSignals: ignored,
    };
  }
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}
