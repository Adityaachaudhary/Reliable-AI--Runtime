import { mkdirSync, rmSync } from 'node:fs';
import { systemClock } from './clock';
import { RulePolicy } from './policy';
import { FakeProvider } from './providers/fakeProvider';
import { driveTurn, printRun } from './render';
import { ConversationRuntime } from './runtime';
import { DEFAULT_INPUTS, scenarioScript, type ScenarioName } from './scenarios';
import { SqliteStore } from './store/sqliteStore';
import type { RunSummary } from './types';

const DB_PATH = 'data/demo.db';
const DELAY_MS = 90;

interface DemoStep {
  title: string;
  scenario: ScenarioName;
  input?: string;
  timeoutMs?: number;
  cancelAfterChunks?: number;
}

const STEPS: DemoStep[] = [
  { title: '1. Successful streamed turn', scenario: 'success' },
  { title: '2. Policy rejection: the provider is never called', scenario: 'success', input: 'Explain how to make a bomb.' },
  { title: '3. Cancellation during streaming (cancel after 3 chunks)', scenario: 'slow', cancelAfterChunks: 3 },
  { title: '4. Timeout during streaming (600 ms deadline, provider hangs)', scenario: 'hang', timeoutMs: 600 },
  { title: '5. Provider failure after partial output (note the redacted key)', scenario: 'fail' },
];

/** Runs all five outcomes with real (short) delays so the stream is visible, then contrasts their persisted traces. */
export async function runDemo(): Promise<void> {
  mkdirSync('data', { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });

  const store = new SqliteStore(DB_PATH);
  const results: RunSummary[] = [];

  for (const step of STEPS) {
    console.log(`\n=== ${step.title} ===`);
    const runtime = new ConversationRuntime({
      provider: new FakeProvider(scenarioScript(step.scenario, DELAY_MS), systemClock),
      policy: new RulePolicy(),
      store,
      clock: systemClock,
    });
    results.push(
      await driveTurn(
        runtime,
        { input: step.input ?? DEFAULT_INPUTS[step.scenario], conversationId: 'demo', timeoutMs: step.timeoutMs },
        { cancelAfterChunks: step.cancelAfterChunks },
      ),
    );
  }

  console.log('\n=== Persisted conversation records (assistant replies exist only for the completed run) ===');
  for (const message of store.listMessages('demo')) {
    console.log(`${message.role.padEnd(9)} [run ${message.runId.slice(0, 8)}] ${JSON.stringify(message.content)}`);
  }

  console.log('\n=== Contrast of operational traces ===');
  for (const summary of results) {
    const run = store.getRun(summary.runId)!;
    console.log('');
    printRun(store, run);
  }
  store.close();
  console.log(`\nDatabase kept at ${DB_PATH}. Inspect any run with: npm run cli -- inspect <runId> --db ${DB_PATH}`);
}
