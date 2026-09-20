import type { Clock } from '../clock';
import { createAbortError, type ModelProvider, type ProviderRequest } from '../provider';
import type { ProviderChunk } from '../types';

export type FakeStep =
  | { text: string }
  | { reasoning: string }
  | { waitMs: number } // pause on the injected clock (abortable)
  | { hang: true } // never produce anything again, until aborted
  | { fail: string } // throw a provider error
  | { raw: unknown }; // emit a malformed event

export type FakeScript = FakeStep[] | ((request: ProviderRequest) => FakeStep[]);

function abortableWait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(createAbortError('provider aborted'));
    const onAbort = () => {
      clock.clearTimeout(handle);
      reject(createAbortError('provider aborted'));
    };
    const handle = clock.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(createAbortError('provider aborted'));
    signal.addEventListener('abort', () => reject(createAbortError('provider aborted')), { once: true });
  });
}

/**
 * Deterministic, scriptable provider used by tests, the benchmark and the CLI demo.
 * Counters let tests prove what the runtime did (or did not) ask of the provider.
 */
export class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  readonly invokedRunIds: string[] = [];
  chunksProduced = 0;
  streamsClosed = 0;

  constructor(
    private readonly script: FakeScript,
    private readonly clock: Clock,
  ) {}

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    this.invokedRunIds.push(request.runId);
    const steps = typeof this.script === 'function' ? this.script(request) : this.script;
    try {
      for (const step of steps) {
        if (request.signal.aborted) throw createAbortError('provider aborted');
        if ('text' in step) {
          this.chunksProduced++;
          yield { type: 'text', text: step.text };
        } else if ('reasoning' in step) {
          this.chunksProduced++;
          yield { type: 'reasoning', text: step.reasoning };
        } else if ('raw' in step) {
          this.chunksProduced++;
          yield step.raw as ProviderChunk;
        } else if ('waitMs' in step) {
          await abortableWait(this.clock, step.waitMs, request.signal);
        } else if ('hang' in step) {
          await waitForAbort(request.signal);
        } else if ('fail' in step) {
          throw new Error(step.fail);
        }
      }
    } finally {
      this.streamsClosed++;
    }
  }
}
