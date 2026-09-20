import type { FakeStep } from './providers/fakeProvider';

/** Named fake-provider scripts for the CLI and the demo. Real waits are used there, so the stream is visible. */
export const SCENARIO_NAMES = ['success', 'reasoning', 'slow', 'hang', 'fail'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

const SENTENCE = ['The ', 'runtime ', 'streams ', 'each ', 'chunk ', 'in ', 'order, ', 'then ', 'completes ', 'once.'];

function paced(chunks: string[], delayMs: number): FakeStep[] {
  return chunks.flatMap((text, i): FakeStep[] => (i === 0 ? [{ text }] : [{ waitMs: delayMs }, { text }]));
}

export function scenarioScript(name: ScenarioName, delayMs: number): FakeStep[] {
  switch (name) {
    case 'success':
      return paced(SENTENCE, delayMs);
    case 'reasoning':
      return [
        { reasoning: 'thinking about the answer (hidden)' },
        ...paced(SENTENCE.slice(0, 4), delayMs),
        { reasoning: 'checking the draft (hidden)' },
        { waitMs: delayMs },
        { text: 'Hidden reasoning was dropped.' },
      ];
    case 'slow':
      return paced(Array.from({ length: 40 }, (_, i) => `chunk-${i + 1} `), delayMs);
    case 'hang':
      return [...paced(SENTENCE.slice(0, 3), delayMs), { hang: true }];
    case 'fail':
      return [
        ...paced(SENTENCE.slice(0, 3), delayMs),
        { waitMs: delayMs },
        { fail: 'upstream returned 502 (request used key sk-demo-0123456789abcdef)' },
      ];
  }
}

export const DEFAULT_INPUTS: Record<ScenarioName, string> = {
  success: 'Tell me how the runtime works.',
  reasoning: 'Answer without showing your work.',
  slow: 'Write a long answer.',
  hang: 'Answer eventually.',
  fail: 'Answer, then break.',
};
