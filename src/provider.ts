import type { ProviderChunk } from './types';

export interface ProviderRequest {
  runId: string;
  input: string;
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  /** Aborted when the run ends in any non-success state. Providers should stop promptly when it fires. */
  signal: AbortSignal;
}

/**
 * The only thing the runtime knows about a model. Provider-specific code (HTTP, SSE parsing,
 * vendor error mapping) lives behind this interface and never leaks into orchestration.
 */
export interface ModelProvider {
  readonly name: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderChunk>;
}

export function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Runtime-side validation: a provider crosses a trust boundary, so its events are checked, not assumed. */
export function parseChunk(raw: unknown): ProviderChunk | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { type, text } = raw as Record<string, unknown>;
  if ((type === 'text' || type === 'reasoning') && typeof text === 'string') return { type, text };
  return undefined;
}
