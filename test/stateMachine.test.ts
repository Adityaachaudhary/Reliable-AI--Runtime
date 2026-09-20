import { describe, expect, it } from 'vitest';
import { RunStateMachine, TERMINAL_STATES, isTerminalState, type TerminalState } from '../src';

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

const streaming = (): RunStateMachine => {
  const machine = new RunStateMachine();
  expect(machine.apply('checking_policy').ok).toBe(true);
  expect(machine.apply('streaming').ok).toBe(true);
  return machine;
};

describe('RunStateMachine', () => {
  it('walks the happy path created -> checking_policy -> streaming -> completed', () => {
    const machine = streaming();
    expect(machine.apply('completed')).toMatchObject({ ok: true, from: 'streaming', to: 'completed' });
    expect(machine.isTerminal).toBe(true);
  });

  it('rejects transitions the table does not allow', () => {
    const machine = new RunStateMachine();
    expect(machine.apply('streaming')).toMatchObject({ ok: false, reason: 'invalid_transition' });
    expect(machine.apply('completed')).toMatchObject({ ok: false, reason: 'invalid_transition' });
    expect(machine.state).toBe('created');
  });

  it('only allows rejection from the policy check, never once streaming', () => {
    const machine = streaming();
    expect(machine.apply('rejected')).toMatchObject({ ok: false, reason: 'invalid_transition' });
  });

  it('never leaves a terminal state', () => {
    for (const terminal of TERMINAL_STATES) {
      const machine = new RunStateMachine();
      machine.apply('checking_policy');
      if (terminal === 'completed') machine.apply('streaming');
      expect(machine.apply(terminal).ok).toBe(true);
      for (const next of ['created', 'checking_policy', 'streaming', ...TERMINAL_STATES] as const) {
        expect(machine.apply(next)).toMatchObject({ ok: false, reason: 'already_terminal' });
      }
      expect(machine.state).toBe(terminal);
    }
  });

  it('AC6: for every ordering of competing terminal attempts, exactly one wins and it is the first', () => {
    const competitors: TerminalState[] = ['completed', 'cancelled', 'timed_out', 'failed'];
    for (const order of permutations(competitors)) {
      const machine = streaming();
      const results = order.map((state) => machine.apply(state));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results[0]?.ok).toBe(true);
      expect(machine.state).toBe(order[0]);
      expect(isTerminalState(machine.state)).toBe(true);
    }
  });
});
