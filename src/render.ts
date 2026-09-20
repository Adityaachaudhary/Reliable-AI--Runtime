import type { ConversationRuntime } from './runtime';
import type { RunRecord, RuntimeStore } from './store/store';
import type { RunSummary, RuntimeEvent, TurnRequest } from './types';

const dim = (text: string) => (process.stdout.isTTY ? `\u001b[2m${text}\u001b[22m` : text);
const bold = (text: string) => (process.stdout.isTTY ? `\u001b[1m${text}\u001b[22m` : text);

function fields(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
    .join(' ');
}

export function formatEvent(event: RuntimeEvent): string {
  const seq = `#${String(event.seq).padStart(2, '0')}`;
  if (event.type === 'text.delta') return `${seq} ${bold('text.delta'.padEnd(30))} ${JSON.stringify(event.text)}`;
  return dim(`${seq} ${event.type.padEnd(30)} ${fields(event.data)}`);
}

export interface DriveOptions {
  cancelAfterChunks?: number;
  showChunkTrace?: boolean;
  /** Also cancel on SIGINT (Ctrl+C), which shows cancellation from a real user action. */
  cancelOnSigint?: boolean;
}

/** Runs one turn, printing every event as it arrives. Shared by the CLI and the demo. */
export async function driveTurn(runtime: ConversationRuntime, request: TurnRequest, options: DriveOptions = {}): Promise<RunSummary> {
  const handle = runtime.startTurn(request);
  console.log(dim(`run ${handle.runId}`));
  if (!options.showChunkTrace) console.log(dim('(provider.chunk trace lines are hidden, so #seq skips them; use --verbose to show)'));

  const onSigint = () => handle.cancel('SIGINT (Ctrl+C)');
  if (options.cancelOnSigint) process.once('SIGINT', onSigint);

  let textChunks = 0;
  for await (const event of handle.events) {
    if (event.type === 'provider.chunk' && !options.showChunkTrace) continue;
    console.log(formatEvent(event));
    if (event.type === 'text.delta') {
      textChunks += 1;
      if (options.cancelAfterChunks && textChunks === options.cancelAfterChunks) {
        console.log(dim('    -> requesting cancellation'));
        handle.cancel('cancelled by CLI');
      }
    }
  }
  const summary = await handle.result;
  process.off('SIGINT', onSigint);
  printSummary(summary);
  return summary;
}

export function printSummary(summary: RunSummary): void {
  console.log('');
  console.log(
    `${bold('terminal state:')} ${summary.state}${summary.reasonCode ? ` (${summary.reasonCode})` : ''}` +
      `   chunks streamed: ${summary.chunkCount}   assistant reply committed: ${summary.assistantMessageCommitted ? 'yes' : 'no'}`,
  );
  if (summary.output) console.log(`streamed text: ${JSON.stringify(summary.output)}${summary.state === 'completed' ? '' : '  (partial, not a committed reply)'}`);
  console.log('');
}

export function printRun(store: RuntimeStore, run: RunRecord): void {
  console.log(bold(`run ${run.id}`));
  console.log(`  conversation: ${run.conversationId}`);
  console.log(`  state: ${run.state}${run.reasonCode ? ` (${run.reasonCode})` : ''}${run.reason ? ` - ${run.reason}` : ''}`);
  console.log(`  input chars: ${run.inputChars}   timeout: ${run.timeoutMs}ms`);
  console.log(`  created: ${new Date(run.createdAt).toISOString()}   ended: ${run.endedAt ? new Date(run.endedAt).toISOString() : '-'}`);
  for (const ignored of run.ignoredSignals) console.log(`  ignored signal: ${ignored.attempted} (${ignored.reason})`);

  const messages = store.listRunMessages(run.id);
  console.log('  persisted conversation records for this run:');
  if (messages.length === 0) console.log('    (none)');
  for (const message of messages) console.log(`    ${message.role.padEnd(9)} ${JSON.stringify(message.content)}`);

  const output = store.getOutput(run.id);
  console.log(`  streamed output history: ${output.length === 0 ? '(none)' : JSON.stringify(output.map((c) => c.text).join(''))}`);

  console.log('  operational trace:');
  for (const entry of store.getTrace(run.id)) console.log('    ' + formatEvent(entry));
}
