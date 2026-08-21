// @vitest-environment jsdom
//
// Task 2: row mode runs no per-variable field pipelines — the shared chunk
// pipeline is the only codec editor rendered, and the mixed-dtype warning
// gates on raw storageDtypes (foldUniformDtype), not post-prefix dtypes.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CodecSection } from '../../../src/components/config/CodecSection.tsx';
import type { Variable } from '../../../src/types/state.ts';
import type { CodecStep } from '../../../src/types/codecs.ts';

function variable(id: string, storageDtype: Variable['typeAssignment']['storageDtype']): Variable {
  return {
    id,
    name: id,
    color: '#e06c75',
    logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
    typeAssignment: { storageDtype },
  };
}

function renderRow(variables: Variable[], fieldPipelines: Record<string, CodecStep[]>) {
  return render(
    <CodecSection
      interleaving="row"
      variables={variables}
      fieldPipelines={fieldPipelines}
      chunkPipeline={[]}
      onFieldPipelineChange={vi.fn()}
      onChunkPipelineChange={vi.fn()}
    />,
  );
}

describe('CodecSection row-mode mixed-dtype warning (raw dtypes)', () => {
  it('banner when raw storageDtypes differ, empty pipelines', () => {
    renderRow([variable('a', 'float32'), variable('b', 'int32')], {});
    expect(screen.getByTestId('codec-mixed-dtype-warning')).toBeTruthy();
  });

  it('no banner when raw storageDtypes are uniform', () => {
    renderRow([variable('a', 'float32'), variable('b', 'float32')], {});
    expect(screen.queryByTestId('codec-mixed-dtype-warning')).toBeNull();
  });
});

describe('CodecSection row mode renders only the shared pipeline', () => {
  it('no per-variable editors, one shared chunk editor, no inactive notes', () => {
    renderRow([variable('a', 'float32'), variable('b', 'float32')], {
      a: [{ codec: 'delta', params: {} }],
      b: [],
    });
    expect(screen.queryByTestId('codec-add-a')).toBeNull();
    expect(screen.queryByTestId('codec-add-b')).toBeNull();
    expect(screen.getByTestId('codec-add-chunk')).toBeTruthy();
    expect(screen.queryByTestId('codec-row-inactive-note-a')).toBeNull();
    expect(screen.queryByTestId('codec-row-inactive-note-b')).toBeNull();
  });
});
