// @vitest-environment jsdom
//
// TypeAssignConfig shows an observed-range note per variable (testid
// type-assign-range-{id}), read from the live VariableStats.min/max so the
// storageDtype/scale choice has a concrete target. Integers render verbatim,
// decimals to <=3 places; an all-NaN variable (non-finite min/max) skips the
// note entirely.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TypeAssignConfig } from '../../../src/components/config/TypeAssignConfig.tsx';
import type { Variable } from '../../../src/types/state.ts';
import type { VariableStats } from '../../../src/types/pipeline.ts';

function variable(id: string, over: Partial<Variable> = {}): Variable {
  return {
    id, name: id, color: '#e06c75',
    logicalType: { type: 'decimal', min: 0, max: 1, decimalPlaces: 1, generation: 'smooth' },
    typeAssignment: { storageDtype: 'float32' },
    ...over,
  };
}

function stats(min: number, max: number): VariableStats {
  return { min, max, mean: (min + max) / 2, count: 4, clipped: 0, rounded: 0, isLossy: false, nanCount: 0 };
}

describe('TypeAssignConfig observed-range note', () => {
  it('renders a decimal range verbatim (trimmed to <=3 places)', () => {
    render(
      <TypeAssignConfig
        variables={[variable('elevation')]}
        variableStats={new Map([['elevation', stats(100, 176.5)]])}
        onUpdateVariable={() => {}}
      />,
    );
    expect(screen.getByTestId('type-assign-range-elevation').textContent).toBe('range 100 … 176.5');
  });

  it('renders integer stats without decimals', () => {
    render(
      <TypeAssignConfig
        variables={[variable('temp', { logicalType: { type: 'integer', min: 0, max: 10, generation: 'smooth' }, typeAssignment: { storageDtype: 'int16' } })]}
        variableStats={new Map([['temp', stats(-1485, 8271)]])}
        onUpdateVariable={() => {}}
      />,
    );
    expect(screen.getByTestId('type-assign-range-temp').textContent).toBe('range -1485 … 8271');
  });

  it('skips the note when min/max are non-finite (all-NaN variable)', () => {
    render(
      <TypeAssignConfig
        variables={[variable('empty')]}
        variableStats={new Map([['empty', stats(NaN, NaN)]])}
        onUpdateVariable={() => {}}
      />,
    );
    expect(screen.queryByTestId('type-assign-range-empty')).toBeNull();
  });
});

// Task 10: the lossy indicator also considers the variable's own codec
// pipeline (codecStats[v.id]), not just the Typed-stage cast stats.
describe('TypeAssignConfig codec-lossy aggregation', () => {
  it('marks a variable lossy from codecStats alone, even with a lossless cast', () => {
    render(
      <TypeAssignConfig
        variables={[variable('t')]}
        variableStats={new Map([['t', stats(0, 1)]])}
        codecStats={{ t: [{ clipped: 2, rounded: 3 }] }}
        onUpdateVariable={() => {}}
      />,
    );
    const container = screen.getByText(/codec: 2 clipped, 3 rounded/);
    expect(container.textContent).toContain('codec: 2 clipped, 3 rounded');
  });

  it('stays lossless when codecStats has no clipped/rounded steps', () => {
    render(
      <TypeAssignConfig
        variables={[variable('t')]}
        variableStats={new Map([['t', stats(0, 1)]])}
        codecStats={{ t: [null, { clipped: 0, rounded: 0 }] }}
        onUpdateVariable={() => {}}
      />,
    );
    expect(screen.queryByText(/codec:/)).toBeNull();
  });
});
