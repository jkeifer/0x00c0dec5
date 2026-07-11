// @vitest-environment jsdom
//
// Task 6 (read plan): ReadStatus gains a progress line above its existing
// success/failure message: "8/8 steps" on success, "N/8 steps · failed at:
// {label}" on failure (N = count of steps with outcome 'ok'). Testid
// read-status-progress. Fixtures build ReadFileResult directly (no engine
// call needed), mirroring readProcessView.test.tsx's plain-ReadStep[] style.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReadStatus } from '../../../src/components/config/ReadStatus.tsx';
import type { ReadFileResult, ReadStep, ReadStepId } from '../../../src/types/pipeline.ts';

const STEP_IDS: ReadStepId[] = [
  'verify-magic',
  'locate-metadata',
  'parse-metadata',
  'read-schema',
  'read-layout',
  'locate-chunks',
  'decode-chunks',
  'reassemble',
];

const LABELS: Record<ReadStepId, string> = {
  'verify-magic': 'Verify magic number',
  'locate-metadata': 'Locate metadata',
  'parse-metadata': 'Parse metadata',
  'read-schema': 'Read schema',
  'read-layout': 'Read layout',
  'locate-chunks': 'Locate chunks',
  'decode-chunks': 'Decode chunks',
  reassemble: 'Reassemble values',
};

function okStep(id: ReadStepId): ReadStep {
  return { id, label: LABELS[id], needed: 'needed', found: 'found', outcome: 'ok' };
}

const ALL_OK_STEPS: ReadStep[] = STEP_IDS.map(okStep);

// Fails at read-schema (index 3): rows 0-2 ok, row 3 failed, rows 4-7 skipped.
const FAILED_AT_SCHEMA_STEPS: ReadStep[] = STEP_IDS.map((id, i) => {
  if (i < 3) return okStep(id);
  if (id === 'read-schema') {
    return { id, label: LABELS[id], needed: 'needed', found: 'no schema key', outcome: 'failed' };
  }
  return { id, label: LABELS[id], needed: 'needed', found: 'not reached', outcome: 'skipped' };
});

const SUCCESS_RESULT: ReadFileResult = {
  success: true,
  reconstructedValues: new Map(),
  lossyVariables: new Set(),
  steps: ALL_OK_STEPS,
};

const FAILURE_RESULT: ReadFileResult = {
  success: false,
  reason: 'missing-schema',
  message: 'Cannot read file.',
  byteCount: 128,
  steps: FAILED_AT_SCHEMA_STEPS,
};

describe('ReadStatus progress line', () => {
  it('shows "8/8 steps" on success', () => {
    render(<ReadStatus readResult={SUCCESS_RESULT} showDiff={false} onShowDiffChange={() => {}} />);
    expect(screen.getByTestId('read-status-progress').textContent).toBe('8/8 steps');
  });

  it('shows "N/8 steps · failed at: {label}" on failure', () => {
    render(<ReadStatus readResult={FAILURE_RESULT} showDiff={false} onShowDiffChange={() => {}} />);
    expect(screen.getByTestId('read-status-progress').textContent).toBe(
      '3/8 steps · failed at: Read schema',
    );
  });
});
