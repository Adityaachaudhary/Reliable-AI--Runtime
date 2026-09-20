import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Restart demo: a real child process is hard-killed (SIGKILL) mid-stream, so it never gets to
 * write a terminal state. A second process then starts, recovers the interrupted run
 * (failed / interrupted_by_restart) and runs a fresh turn.
 */
const DB = 'data/crash-demo.db';
mkdirSync('data', { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(DB + suffix, { force: true });

const cli = (...args: string[]) => spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args, '--db', DB], { stdio: ['ignore', 'pipe', 'inherit'] });

async function main(): Promise<void> {
  console.log('=== process 1: start a turn whose provider hangs, then kill -9 it mid-stream ===');
  const first = cli('run', '--scenario', 'hang', '--timeout', '600000', '--delay', '80');
  let textChunks = 0;
  const exited = new Promise<void>((resolve) => first.on('exit', () => resolve()));
  createInterface({ input: first.stdout! }).on('line', (line) => {
    console.log(line);
    if (line.includes('text.delta') && ++textChunks === 3) {
      console.log('>>> SIGKILL: the process dies without writing a terminal state <<<');
      first.kill('SIGKILL');
    }
  });
  await exited;

  console.log('\n=== process 2: restart, recover, then run a fresh turn ===');
  const second = cli('run', '--scenario', 'success', '--delay', '40');
  createInterface({ input: second.stdout! }).on('line', (line) => console.log(line));
  await new Promise<void>((resolve) => second.on('exit', () => resolve()));

  console.log('\n=== runs in the database ===');
  const list = cli('list');
  createInterface({ input: list.stdout! }).on('line', (line) => console.log(line));
  await new Promise<void>((resolve) => list.on('exit', () => resolve()));
  console.log(`\nInspect the interrupted run with: npm run cli -- inspect <runId> --db ${DB}`);
}

await main();
