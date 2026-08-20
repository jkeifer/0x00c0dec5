// @vitest-environment jsdom
//
// Task 11: CodecPipelineEditor's `inactiveFrom` prop dims steps at index >=
// inactiveFrom (opacity 0.45) and renders a note on the first inactive step
// (codec-row-inactive-note-{variableSlot}) explaining why row mode can't run
// it per-variable. Absent/out-of-range inactiveFrom renders no note and full
// opacity everywhere (existing behavior unchanged).
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CodecPipelineEditor } from '../../../src/components/config/CodecPipelineEditor.tsx';

describe('CodecPipelineEditor inactiveFrom', () => {
  it('renders no inactive note when inactiveFrom is absent', () => {
    render(
      <CodecPipelineEditor
        steps={[{ codec: 'quantize', params: {} }, { codec: 'scale-offset', params: {} }]}
        inputDtype="float32"
        onChange={vi.fn()}
        variableSlot="temp"
      />,
    );
    expect(screen.queryByTestId('codec-row-inactive-note-temp')).toBeNull();
  });

  it('renders no inactive note when inactiveFrom === steps.length (all active)', () => {
    render(
      <CodecPipelineEditor
        steps={[{ codec: 'quantize', params: {} }, { codec: 'scale-offset', params: {} }]}
        inputDtype="float32"
        onChange={vi.fn()}
        variableSlot="temp"
        inactiveFrom={2}
      />,
    );
    expect(screen.queryByTestId('codec-row-inactive-note-temp')).toBeNull();
    const step0 = screen.getByTestId('codec-step-temp-0');
    const step1 = screen.getByTestId('codec-step-temp-1');
    expect(step0.style.opacity).toBe('1');
    expect(step1.style.opacity).toBe('1');
  });

  it('dims steps at/after inactiveFrom and notes the first one', () => {
    render(
      <CodecPipelineEditor
        steps={[
          { codec: 'quantize', params: {} },
          { codec: 'delta', params: {} },
          { codec: 'rle', params: {} },
        ]}
        inputDtype="float32"
        onChange={vi.fn()}
        variableSlot="temp"
        inactiveFrom={1}
      />,
    );
    const step0 = screen.getByTestId('codec-step-temp-0');
    const step1 = screen.getByTestId('codec-step-temp-1');
    const step2 = screen.getByTestId('codec-step-temp-2');
    expect(step0.style.opacity).toBe('1');
    expect(step1.style.opacity).toBe('0.45');
    expect(step2.style.opacity).toBe('0.45');

    const note = screen.getByTestId('codec-row-inactive-note-temp');
    expect(note.textContent).toContain(
      'inactive in row mode — output past this step has no per-element structure to interleave',
    );
    // Note renders once, on the first inactive step only.
    expect(screen.queryAllByTestId('codec-row-inactive-note-temp')).toHaveLength(1);
  });
});
