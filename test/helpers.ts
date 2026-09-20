import {
  ConversationRuntime,
  ManualClock,
  RulePolicy,
  SqliteStore,
  type ModelProvider,
  type Policy,
  type RuntimeEvent,
  type TextEvent,
  type TraceEntry,
  type TurnHandle,
} from '../src';

export interface HarnessOptions {
  provider: ModelProvider;
  policy?: Policy;
  timeoutMs?: number;
  clock?: ManualClock;
  store?: SqliteStore;
}

/** Runtime wired with a deterministic clock, in-memory SQLite and predictable run ids. */
export function makeHarness(options: HarnessOptions) {
  const clock = options.clock ?? new ManualClock(1_000);
  const store = options.store ?? new SqliteStore(':memory:');
  const internalErrors: unknown[] = [];
  let counter = 0;
  const runtime = new ConversationRuntime({
    provider: options.provider,
    policy: options.policy ?? new RulePolicy(),
    store,
    clock,
    ids: () => `run-${++counter}`,
    defaultTimeoutMs: options.timeoutMs ?? 5_000,
    onInternalError: (error) => internalErrors.push(error),
  });
  return { runtime, store, clock, internalErrors };
}

/** Consumes a handle's stream in the background and returns the live array plus a completion promise. */
export function record(handle: TurnHandle): { events: RuntimeEvent[]; done: Promise<void> } {
  const events: RuntimeEvent[] = [];
  const done = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  return { events, done };
}

export const isText = (event: RuntimeEvent): event is TextEvent => event.type === 'text.delta';
export const texts = (events: RuntimeEvent[]): string[] => events.filter(isText).map((event) => event.text);
export const traceTypes = (trace: TraceEntry[]): string[] => trace.map((entry) => entry.type);
