import type { TraceData } from './types';

export const REDACTED = '[REDACTED]';

/** Field names whose values are never written to the trace, whatever they contain. */
const SENSITIVE_KEY = /api[-_]?key|authorization|token|secret|password|passwd|credential|cookie/i;

/** Value shapes that look like credentials. Illustrative, not exhaustive. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/, // OpenAI-style keys
  /\bgsk_[A-Za-z0-9]{8,}/, // Groq-style keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/, // Authorization header values
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key ids
  /\b(?:api[_-]?key|secret|password|token)\s*[=:]\s*\S{6,}/, // key=value in free text
];

export function redactString(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(new RegExp(pattern.source, 'gi'), REDACTED);
  return out;
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => new RegExp(pattern.source, 'i').test(text));
}

/** Redacts by key name first, then by value shape. */
export function redactRecord(record: TraceData): TraceData {
  const out: TraceData = {};
  for (const [key, value] of Object.entries(record)) {
    if (SENSITIVE_KEY.test(key)) out[key] = REDACTED;
    else out[key] = typeof value === 'string' ? redactString(value) : value;
  }
  return out;
}

/**
 * Whitelist-style error summary: only `name` and `message` are ever read, so headers, configs
 * and causes attached to provider errors (a common place for API keys) cannot reach the trace.
 */
export function safeErrorFields(error: unknown): { errorName: string; errorMessage: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return { errorName: redactString(name).slice(0, 80), errorMessage: redactString(message).slice(0, 300) };
}
