import { TERMINAL_STATES, type RunState, type TerminalState } from './types';

/**
 * The single source of truth for what a run may do next.
 * Terminal states have no outgoing edges, so "one terminal state wins" is structural.
 */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  created: ['checking_policy', 'cancelled', 'timed_out', 'failed'],
  checking_policy: ['streaming', 'rejected', 'cancelled', 'timed_out', 'failed'],
  streaming: ['completed', 'cancelled', 'timed_out', 'failed'],
  completed: [],
  rejected: [],
  cancelled: [],
  timed_out: [],
  failed: [],
};

export function isTerminalState(state: RunState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export type TransitionCheck =
  | { ok: true; from: RunState; to: RunState }
  | { ok: false; from: RunState; to: RunState; reason: 'already_terminal' | 'invalid_transition' };

/**
 * In-memory state holder for one run. `check` and `apply` are synchronous, so within a
 * single-threaded event loop two competing terminal attempts can never both succeed.
 */
export class RunStateMachine {
  private current: RunState = 'created';

  get state(): RunState {
    return this.current;
  }

  get isTerminal(): boolean {
    return isTerminalState(this.current);
  }

  check(to: RunState): TransitionCheck {
    const from = this.current;
    if (isTerminalState(from)) return { ok: false, from, to, reason: 'already_terminal' };
    if (!TRANSITIONS[from].includes(to)) return { ok: false, from, to, reason: 'invalid_transition' };
    return { ok: true, from, to };
  }

  apply(to: RunState): TransitionCheck {
    const result = this.check(to);
    if (result.ok) this.current = to;
    return result;
  }
}
