import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { runDemo } from './demo';
import { FakeProvider } from './providers/fakeProvider';
import { driveTurn, printRun } from './render';
import { RulePolicy } from './policy';
import { ConversationRuntime } from './runtime';
import { DEFAULT_INPUTS, SCENARIO_NAMES, scenarioScript, type ScenarioName } from './scenarios';
import { systemClock } from './clock';
import { SqliteStore } from './store/sqliteStore';

const USAGE = `Usage:
  npm run cli -- run [--scenario ${SCENARIO_NAMES.join('|')}] [--input "text"] [--timeout ms]
                     [--cancel-after N] [--delay ms] [--verbose] [--db path]
  npm run cli -- list [--db path]
  npm run cli -- inspect <runId> [--db path]
  npm run demo                      (all five outcomes back to back)

Scenarios use a deterministic fake provider (no network, no API key).
An input containing a blocked term (e.g. "make a bomb") is rejected before the provider runs.
Press Ctrl+C during a run to cancel it.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: 'string', default: 'success' },
    input: { type: 'string' },
    timeout: { type: 'string' },
    'cancel-after': { type: 'string' },
    delay: { type: 'string', default: '120' },
    db: { type: 'string', default: 'data/runtime.db' },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function openStore(path: string): SqliteStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return new SqliteStore(path);
}

const [command, argument] = positionals;

if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

if (command === 'demo') {
  await runDemo();
} else if (command === 'run') {
  const scenario = values.scenario as ScenarioName;
  if (!SCENARIO_NAMES.includes(scenario)) {
    console.error(`Unknown scenario "${scenario}". Choose one of: ${SCENARIO_NAMES.join(', ')}`);
    process.exit(1);
  }
  const store = openStore(values.db!);
  const runtime = new ConversationRuntime({
    provider: new FakeProvider(scenarioScript(scenario, Number(values.delay)), systemClock),
    policy: new RulePolicy(),
    store,
    clock: systemClock,
  });
  const recovered = runtime.recoverInterruptedRuns();
  if (recovered.length > 0) console.log(`recovered ${recovered.length} interrupted run(s) from a previous process: ${recovered.join(', ')}\n`);

  const summary = await driveTurn(
    runtime,
    {
      input: values.input ?? DEFAULT_INPUTS[scenario],
      conversationId: 'cli',
      timeoutMs: values.timeout ? Number(values.timeout) : undefined,
    },
    {
      cancelAfterChunks: values['cancel-after'] ? Number(values['cancel-after']) : undefined,
      showChunkTrace: values.verbose,
      cancelOnSigint: true,
    },
  );
  if (values.db !== ':memory:') {
    console.log(`inspect it later with: npm run cli -- inspect ${summary.runId}${values.db === 'data/runtime.db' ? '' : ` --db ${values.db}`}`);
  }
  store.close();
} else if (command === 'list') {
  const store = openStore(values.db!);
  const runs = store.listRuns(20);
  if (runs.length === 0) console.log('(no runs)');
  for (const run of runs) {
    console.log(`${run.id}  ${run.state.padEnd(10)} ${(run.reasonCode ?? '').padEnd(22)} ${new Date(run.createdAt).toISOString()}`);
  }
  store.close();
} else if (command === 'inspect') {
  if (!argument) {
    console.error('inspect needs a run id (see `npm run cli -- list`)');
    process.exit(1);
  }
  const store = openStore(values.db!);
  const run = store.getRun(argument);
  if (!run) {
    console.error(`no run with id ${argument}`);
    process.exit(1);
  }
  printRun(store, run);
  store.close();
} else {
  console.error(`Unknown command "${command}"\n\n${USAGE}`);
  process.exit(1);
}
