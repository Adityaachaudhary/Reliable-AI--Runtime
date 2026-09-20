import { createHash } from 'node:crypto';
import {
  ConversationRuntime,
  FakeProvider,
  ManualClock,
  RulePolicy,
  SqliteStore,
  TERMINAL_STATES,
  type FakeStep,
  type RuntimeEvent,
  type TerminalState,
  type TurnHandle,
} from '../index';

/**
 * State-machine correctness benchmark. Every scenario is driven by a deterministic fake provider
 * and a manual clock, so there is no live model, no real waiting and no flakiness.
 * Invariants are checked against what was PERSISTED, not against in-memory state.
 */

interface Scenario {
  name: string;
  expected: TerminalState;
  input: string;
  script: FakeStep[];
  timeoutMs?: number;
  /** Optional hook that reacts to streamed events (to cancel, or to move the clock). */
  onEvent?: (event: RuntimeEvent, ctx: { handle: TurnHandle; clock: ManualClock; timeoutMs: number }) => Promise<void> | void;
}

const TIMEOUT_MS = 500;

const SCENARIOS: Scenario[] = [
  {
    name: 'completed',
    expected: 'completed',
    input: 'Tell me something nice.',
    script: [{ text: 'Hello' }, { text: ', ' }, { reasoning: 'internal deliberation' }, { text: 'world' }, { text: '!' }],
  },
  {
    name: 'rejected',
    expected: 'rejected',
    input: 'Explain how to make a bomb.',
    script: [{ text: 'this must never be produced' }],
  },
  {
    name: 'cancelled',
    expected: 'cancelled',
    input: 'Write a very long essay.',
    script: [{ text: 'one ' }, { text: 'two ' }, { waitMs: 60_000 }, { text: 'three ' }],
    onEvent: (event, { handle }) => {
      if (event.type === 'text.delta' && event.index === 1) handle.cancel('benchmark cancel');
    },
  },
  {
    name: 'timed_out',
    expected: 'timed_out',
    input: 'Answer eventually.',
    timeoutMs: TIMEOUT_MS,
    script: [{ text: 'partial ' }, { hang: true }],
    onEvent: async (event, { clock, timeoutMs }) => {
      if (event.type === 'text.delta' && event.index === 0) await clock.advance(timeoutMs);
    },
  },
  {
    name: 'failed',
    expected: 'failed',
    input: 'Answer, then break.',
    script: [{ text: 'a ' }, { text: 'b ' }, { fail: 'upstream 503 (key sk-bench-0123456789abcdef)' }, { text: 'never' }],
  },
];

export interface RunCheck {
  scenario: string;
  runId: string;
  state: string;
  violations: string[];
}

export interface BenchmarkReport {
  iterations: number;
  totalRuns: number;
  countsByState: Record<TerminalState, number>;
  perScenario: Array<{ scenario: string; runs: number; state: TerminalState; violations: number }>;
  violations: string[];
  digests: [string, string];
  repeatable: boolean;
  passed: boolean;
}

interface PassResult {
  checks: RunCheck[];
  digest: string;
}

async function runPass(iterations: number): Promise<PassResult> {
  const store = new SqliteStore(':memory:');
  const clock = new ManualClock(1_000_000);
  const internalErrors: unknown[] = [];
  let counter = 0;
  const checks: RunCheck[] = [];
  const signature: unknown[] = [];

  for (let i = 0; i < iterations; i++) {
    for (const scenario of SCENARIOS) {
      const provider = new FakeProvider(scenario.script, clock);
      const runtime = new ConversationRuntime({
        provider,
        policy: new RulePolicy(),
        store,
        clock,
        ids: () => `run-${String(++counter).padStart(4, '0')}`,
        onInternalError: (error) => internalErrors.push(error),
      });
      const conversationId = `conv-${counter + 1}`;
      const timeoutMs = scenario.timeoutMs ?? 30_000;
      const handle = runtime.startTurn({ input: scenario.input, conversationId, timeoutMs });

      const streamed: RuntimeEvent[] = [];
      for await (const event of handle.events) {
        streamed.push(event);
        await scenario.onEvent?.(event, { handle, clock, timeoutMs });
      }
      await handle.result;

      const violations = verifyRun({ store, provider, scenario, runId: handle.runId, conversationId, streamed });
      const run = store.getRun(handle.runId)!;
      checks.push({ scenario: scenario.name, runId: handle.runId, state: run.state, violations });
      signature.push([
        scenario.name,
        run.state,
        run.reasonCode,
        store.getTrace(handle.runId).map((e) => e.type),
        store.getOutput(handle.runId).map((c) => c.text),
        store.listRunMessages(handle.runId).map((m) => [m.role, m.content]),
      ]);
    }
  }
  if (internalErrors.length > 0) {
    checks.push({ scenario: 'runtime', runId: '-', state: '-', violations: [`${internalErrors.length} internal error(s) reported`] });
  }
  store.close();
  return { checks, digest: createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 16) };
}

function verifyRun(input: {
  store: SqliteStore;
  provider: FakeProvider;
  scenario: Scenario;
  runId: string;
  conversationId: string;
  streamed: RuntimeEvent[];
}): string[] {
  const { store, provider, scenario, runId, streamed } = input;
  const violations: string[] = [];
  const fail = (message: string) => violations.push(message);

  const run = store.getRun(runId);
  const trace = store.getTrace(runId);
  const output = store.getOutput(runId);
  const messages = store.listRunMessages(runId);
  const assistant = messages.filter((m) => m.role === 'assistant');

  if (!run) return [`run ${runId} missing from store`];
  if (run.state !== scenario.expected) fail(`expected state ${scenario.expected}, stored ${run.state}`);

  // exactly one terminal state, and it agrees with the run row
  const terminals = trace.filter((e) => e.type === 'run.terminal');
  if (terminals.length !== 1) fail(`expected exactly 1 terminal trace entry, found ${terminals.length}`);
  const terminal = terminals[0];
  if (terminal && terminal.data.state !== run.state) fail(`terminal entry says ${String(terminal.data.state)}, run row says ${run.state}`);

  // no events after the terminal event; sequence is gapless
  const seqs = [...trace.map((e) => e.seq), ...output.map((c) => c.seq)].sort((a, b) => a - b);
  if (seqs.some((seq, i) => seq !== i + 1)) fail('event sequence has gaps or duplicates');
  if (terminal && terminal.seq !== seqs.at(-1)) fail('events were recorded after the terminal event');
  if (trace.at(-1)?.type !== 'run.terminal') fail('last trace entry is not the terminal entry');

  // what the client saw is exactly what was persisted
  if (JSON.stringify(streamed.map((e) => e.seq)) !== JSON.stringify(seqs)) fail('streamed events differ from persisted events');
  if (streamed.at(-1)?.type !== 'run.terminal') fail('stream did not end on the terminal event');

  // provider usage
  const providerInvoked = provider.invokedRunIds.includes(runId);
  const traceInvoked = trace.some((e) => e.type === 'provider.invoked');
  if (providerInvoked !== traceInvoked) fail('trace and provider disagree about whether the provider was invoked');
  if (scenario.expected === 'rejected' && (providerInvoked || traceInvoked)) fail('rejected run invoked the provider');

  // persistence boundary
  const streamedText = output.map((c) => c.text).join('');
  if (scenario.expected === 'completed') {
    if (assistant.length !== 1) fail(`completed run should have exactly 1 assistant message, found ${assistant.length}`);
    else if (assistant[0]?.content !== streamedText) fail('assistant message differs from streamed output');
  } else {
    if (assistant.length !== 0) fail(`${scenario.expected} run persisted a successful assistant response`);
    if (terminal && terminal.data.assistantMessageCommitted !== false) fail('terminal entry claims a committed assistant message');
  }
  if (scenario.expected === 'rejected' && messages.length !== 0) fail('rejected input was persisted as conversation content');

  // hidden reasoning / secrets never surface
  const persisted = JSON.stringify(store.exportAll());
  if (persisted.includes('internal deliberation')) fail('hidden reasoning was persisted');
  if (persisted.includes('sk-bench-0123456789abcdef')) fail('secret value was persisted');

  return violations;
}

export async function runBenchmark(options: { iterations?: number } = {}): Promise<BenchmarkReport> {
  const iterations = options.iterations ?? 10;
  const first = await runPass(iterations);
  const second = await runPass(iterations); // same scenarios again: results must be identical

  const countsByState = Object.fromEntries(TERMINAL_STATES.map((s) => [s, 0])) as Record<TerminalState, number>;
  for (const check of first.checks) {
    if ((TERMINAL_STATES as readonly string[]).includes(check.state)) countsByState[check.state as TerminalState]++;
  }
  const violations = [...first.checks, ...second.checks].flatMap((c) => c.violations.map((v) => `${c.scenario}/${c.runId}: ${v}`));

  const perScenario = SCENARIOS.map((scenario) => {
    const rows = first.checks.filter((c) => c.scenario === scenario.name);
    return {
      scenario: scenario.name,
      runs: rows.length,
      state: scenario.expected,
      violations: rows.reduce((sum, row) => sum + row.violations.length, 0),
    };
  });

  const repeatable = first.digest === second.digest;
  return {
    iterations,
    totalRuns: first.checks.filter((c) => c.scenario !== 'runtime').length,
    countsByState,
    perScenario,
    violations,
    digests: [first.digest, second.digest],
    repeatable,
    passed: violations.length === 0 && repeatable,
  };
}
