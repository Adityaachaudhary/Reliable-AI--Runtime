import { createAbortError, type ModelProvider, type ProviderRequest } from '../provider';
import type { ProviderChunk } from '../types';

type Item = { kind: 'chunk'; chunk: unknown } | { kind: 'end' } | { kind: 'error'; error: Error };
type Pending = { resolve: (r: IteratorResult<ProviderChunk>) => void; reject: (e: unknown) => void };

/**
 * Test double where the test decides exactly when each event arrives. Useful for races
 * (cancel vs. completion) because nothing depends on timers.
 *
 * `respectsAbort: false` models a misbehaving provider that ignores the abort signal, to
 * prove the runtime stops consuming it anyway.
 */
export class ControllableProvider implements ModelProvider {
  readonly name = 'controllable';
  invocations = 0;
  /** How many times the runtime asked for the next event. Must stop growing once a run is terminal. */
  pulls = 0;
  closed = false;
  lastSignal: AbortSignal | undefined;

  private readonly queue: Item[] = [];
  private pending: Pending | undefined;

  constructor(private readonly options: { respectsAbort?: boolean } = {}) {}

  push(text: string): void {
    this.enqueue({ kind: 'chunk', chunk: { type: 'text', text } });
  }

  pushReasoning(text: string): void {
    this.enqueue({ kind: 'chunk', chunk: { type: 'reasoning', text } });
  }

  pushRaw(raw: unknown): void {
    this.enqueue({ kind: 'chunk', chunk: raw });
  }

  end(): void {
    this.enqueue({ kind: 'end' });
  }

  fail(error: Error): void {
    this.enqueue({ kind: 'error', error });
  }

  stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.invocations++;
    this.lastSignal = request.signal;
    if (this.options.respectsAbort ?? true) {
      request.signal.addEventListener(
        'abort',
        () => {
          const waiting = this.pending;
          this.pending = undefined;
          waiting?.reject(createAbortError('provider aborted'));
        },
        { once: true },
      );
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.pull(),
        return: async () => {
          this.closed = true;
          return { done: true as const, value: undefined };
        },
      }),
    };
  }

  private pull(): Promise<IteratorResult<ProviderChunk>> {
    this.pulls++;
    const item = this.queue.shift();
    return new Promise((resolve, reject) => {
      if (item) this.deliver(item, { resolve, reject });
      else this.pending = { resolve, reject };
    });
  }

  private enqueue(item: Item): void {
    const waiting = this.pending;
    if (waiting) {
      this.pending = undefined;
      this.deliver(item, waiting);
    } else {
      this.queue.push(item);
    }
  }

  private deliver(item: Item, target: Pending): void {
    if (item.kind === 'chunk') target.resolve({ done: false, value: item.chunk as ProviderChunk });
    else if (item.kind === 'end') target.resolve({ done: true, value: undefined });
    else target.reject(item.error);
  }
}
