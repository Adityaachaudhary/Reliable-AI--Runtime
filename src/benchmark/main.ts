import { runBenchmark } from './runBenchmark';

const iterationsArg = process.argv.find((arg) => arg.startsWith('--iterations='));
const iterations = iterationsArg ? Number(iterationsArg.split('=')[1]) : 10;

const report = await runBenchmark({ iterations });

console.log('Reliable AI Conversation Runtime: state-machine benchmark');
console.log(`iterations per scenario: ${report.iterations}   total runs (one pass): ${report.totalRuns}   passes: 2`);
console.log('');
console.log('scenario      runs  expected terminal   invariant violations');
for (const row of report.perScenario) {
  console.log(`${row.scenario.padEnd(13)} ${String(row.runs).padEnd(5)} ${row.state.padEnd(19)} ${row.violations}`);
}
console.log('');
console.log('terminal-state counts: ' + Object.entries(report.countsByState).map(([state, count]) => `${state}=${count}`).join('  '));
console.log('checked per run: one terminal event | nothing after it | gapless seq | streamed == persisted |');
console.log('                 rejected never invokes provider | non-success never persists an assistant reply |');
console.log('                 no hidden reasoning or secrets persisted');
console.log(`repeatable (2 passes, digests ${report.digests[0]} / ${report.digests[1]}): ${report.repeatable ? 'yes' : 'NO'}`);
if (report.violations.length > 0) {
  console.log('');
  for (const violation of report.violations.slice(0, 20)) console.log('VIOLATION ' + violation);
}
console.log('');
console.log(report.passed ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(report.passed ? 0 : 1);
