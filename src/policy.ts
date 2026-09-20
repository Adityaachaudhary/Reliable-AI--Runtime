import { containsSecret } from './redact';
import type { PolicyDecision } from './types';

/**
 * Pre-response gate. It runs before the provider is ever invoked and must be deterministic.
 * A policy that throws is treated as a failure (fail closed), never as "allowed".
 */
export interface Policy {
  evaluate(input: string): PolicyDecision | Promise<PolicyDecision>;
}

export const DEFAULT_BLOCKED_TERMS: readonly string[] = ['make a bomb', 'build a bomb', 'steal passwords'];

export interface RulePolicyOptions {
  maxInputChars?: number;
  blockedTerms?: readonly string[];
}

const reject = (code: string, reason: string): PolicyDecision => ({ allowed: false, code, reason });

export class RulePolicy implements Policy {
  constructor(private readonly options: RulePolicyOptions = {}) {}

  evaluate(input: string): PolicyDecision {
    const maxChars = this.options.maxInputChars ?? 2000;
    const terms = this.options.blockedTerms ?? DEFAULT_BLOCKED_TERMS;

    if (input.trim().length === 0) return reject('empty_input', 'Input is empty');
    if (input.length > maxChars) return reject('input_too_long', `Input exceeds ${maxChars} characters`);
    if (containsSecret(input)) {
      return reject('secret_in_input', 'Input appears to contain a credential; remove it and try again');
    }
    const lowered = input.toLowerCase();
    if (terms.some((term) => lowered.includes(term.toLowerCase()))) {
      return reject('blocked_term', 'Input matches a blocked content rule');
    }
    return { allowed: true };
  }
}
