import { describe, expect, it } from 'vitest';
import { runBenchmark } from '../src/benchmark/runBenchmark';

describe('verification benchmark', () => {
  it('10 iterations of each scenario satisfy every state-machine invariant and repeat identically', async () => {
    const report = await runBenchmark({ iterations: 10 });
    expect(report.violations).toEqual([]);
    expect(report.totalRuns).toBe(50);
    expect(report.countsByState).toEqual({ completed: 10, rejected: 10, cancelled: 10, timed_out: 10, failed: 10 });
    expect(report.repeatable).toBe(true);
    expect(report.passed).toBe(true);
  });
});
