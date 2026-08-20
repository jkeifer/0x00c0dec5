// @vitest-environment jsdom
//
// Task 10: CodecPipelineEditor renders a per-step lossy badge (codec-lossy-
// {variableSlot}-{i}) from the worker-computed stepStats, when clipped+rounded
// > 0. Absent/zero stats render no badge.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CodecPipelineEditor } from '../../../src/components/config/CodecPipelineEditor.tsx';

describe('CodecPipelineEditor per-step lossy badge', () => {
  it('renders the badge with clipped/rounded counts when stats are present', () => {
    render(
      <CodecPipelineEditor
        steps={[{ codec: 'scale-offset', params: {} }]}
        inputDtype="float32"
        onChange={vi.fn()}
        variableSlot="temp"
        stepStats={[{ clipped: 2, rounded: 5 }]}
      />,
    );
    const badge = screen.getByTestId('codec-lossy-temp-0');
    expect(badge.textContent).toContain('2 clipped');
    expect(badge.textContent).toContain('5 rounded');
  });

  it('renders no badge when stepStats is absent', () => {
    render(
      <CodecPipelineEditor
        steps={[{ codec: 'scale-offset', params: {} }]}
        inputDtype="float32"
        onChange={vi.fn()}
        variableSlot="temp"
      />,
    );
    expect(screen.queryByTestId('codec-lossy-temp-0')).toBeNull();
  });

  it('renders no badge when the step stat is null (e.g. delta)', () => {
    render(
      <CodecPipelineEditor
        steps={[{ codec: 'delta', params: {} }]}
        inputDtype="int16"
        onChange={vi.fn()}
        variableSlot="temp"
        stepStats={[null]}
      />,
    );
    expect(screen.queryByTestId('codec-lossy-temp-0')).toBeNull();
  });

  it('renders no badge when clipped and rounded are both zero', () => {
    render(
      <CodecPipelineEditor
        steps={[{ codec: 'scale-offset', params: {} }]}
        inputDtype="float32"
        onChange={vi.fn()}
        variableSlot="temp"
        stepStats={[{ clipped: 0, rounded: 0 }]}
      />,
    );
    expect(screen.queryByTestId('codec-lossy-temp-0')).toBeNull();
  });
});
