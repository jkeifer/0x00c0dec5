// @vitest-environment jsdom
//
// Task 11 fix: the row-mode mixed-dtype warning banner gates on POST-PREFIX
// dtypes (what the chunk pipeline's interleaved input actually is), not raw
// storage dtypes. Raw-mixed schemas whose structured prefixes converge (e.g.
// every variable ends in scale-offset to int16) have nothing to warn about;
// raw-uniform schemas whose prefixes diverge do.
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

describe('CodecSection row-mode mixed-dtype warning (post-prefix)', () => {
  it('no banner when raw dtypes differ but post-prefix dtypes converge', () => {
    renderRow([variable('a', 'float32'), variable('b', 'float64')], {
      a: [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }],
      b: [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float64', targetDtype: 'int16' } }],
    });
    expect(screen.queryByTestId('codec-mixed-dtype-warning')).toBeNull();
  });

  it('banner when raw dtypes match but post-prefix dtypes diverge', () => {
    renderRow([variable('a', 'float32'), variable('b', 'float32')], {
      a: [{ codec: 'scale-offset', params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' } }],
      b: [],
    });
    expect(screen.getByTestId('codec-mixed-dtype-warning')).toBeTruthy();
  });

  it('no banner for uniform dtypes with no pipelines', () => {
    renderRow([variable('a', 'float32'), variable('b', 'float32')], {});
    expect(screen.queryByTestId('codec-mixed-dtype-warning')).toBeNull();
  });
});
