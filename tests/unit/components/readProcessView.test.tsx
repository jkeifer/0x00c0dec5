// @vitest-environment jsdom
//
// Task 4 (read plan): ReadProcessView renders the reader's 8-step narrated
// log (ReadStep[], read plan Tasks 2-3) as a checklist — one row per step,
// with an outcome icon, label, and needed/found text. A failed row expands
// with its `detail` in the CodecSection warningDim banner idiom; rows after
// a failure are 'skipped' and rendered muted. Fixtures below are built as
// plain ReadStep[] (no engine calls needed) mirroring READ_STEP_ORDER's 8
// ids/labels (src/engine/read.ts).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReadProcessView } from '../../../src/components/viewers/ReadProcessView.tsx';
import type { ReadStep, ReadStepId } from '../../../src/types/pipeline.ts';

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
  return {
    id,
    label: LABELS[id],
    needed: `${LABELS[id]} needed text`,
    found: `${LABELS[id]} found text`,
    outcome: 'ok',
  };
}

const ALL_OK_STEPS: ReadStep[] = STEP_IDS.map(okStep);

// Fails at decode-chunks (index 6): rows 0-5 ok, row 6 failed with a detail,
// row 7 (reassemble) skipped/not reached — mirrors StepRecorder.fail()'s
// behavior in src/engine/read.ts.
const FAILED_AT_DECODE_STEPS: ReadStep[] = STEP_IDS.map((id, i) => {
  if (i < 6) return okStep(id);
  if (id === 'decode-chunks') {
    return {
      id,
      label: LABELS[id],
      needed: LABELS[id] + ' needed text',
      found: 'codec reversal failed',
      outcome: 'failed',
      detail: 'RLE stream ended mid-run; expected 4 more bytes.',
    };
  }
  return {
    id,
    label: LABELS[id],
    needed: LABELS[id] + ' needed text',
    found: 'not reached',
    outcome: 'skipped',
  };
});

describe('ReadProcessView', () => {
  it('renders all rows with ok icons and needed/found text when every step succeeded', () => {
    render(<ReadProcessView steps={ALL_OK_STEPS} />);

    expect(screen.getByTestId('read-process-view')).toBeTruthy();

    for (const id of STEP_IDS) {
      const row = screen.getByTestId(`read-step-${id}`);
      expect(row).toBeTruthy();
      expect(row.textContent).toContain(LABELS[id]);
      expect(row.textContent).toContain(`${LABELS[id]} needed text`);
      expect(row.textContent).toContain(`${LABELS[id]} found text`);
      expect(row.textContent).toContain('✓'); // checkmark
    }
  });

  it('renders ok rows, an expanded failed row with detail, and muted skipped rows', () => {
    render(<ReadProcessView steps={FAILED_AT_DECODE_STEPS} />);

    // rows 0-5: ok
    for (const id of STEP_IDS.slice(0, 6)) {
      const row = screen.getByTestId(`read-step-${id}`);
      expect(row.textContent).toContain('✓');
    }

    // row 6: decode-chunks, failed, detail visible
    const failedRow = screen.getByTestId('read-step-decode-chunks');
    expect(failedRow.textContent).toContain('✗'); // cross mark
    expect(failedRow.textContent).toContain('RLE stream ended mid-run; expected 4 more bytes.');

    // row 7: reassemble, skipped, muted
    const skippedRow = screen.getByTestId('read-step-reassemble');
    expect(skippedRow.textContent).toContain('not reached');
    expect(skippedRow.style.color).toBe('var(--text-tertiary)');
  });
});
