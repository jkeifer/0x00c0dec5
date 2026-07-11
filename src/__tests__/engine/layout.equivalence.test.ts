import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../../types/state.ts';
import { computeValuesStage, computeTypedStage } from '../../hooks/usePipeline.ts';
import { buildValueBlocksLayout, traceAt } from '../../engine/layout.ts';
import { expectTraceEquivalence } from '../helpers/equivalence.ts';

// A text variable exercises the variable-stride offsets path.
const TEXT_VAR = {
  ...DEFAULT_STATE.variables[0],
  id: 'label', name: 'label', color: '#c678dd',
  logicalType: { type: 'text', min: 0, max: 0, wordSet: 'names', generation: 'random' },
  typeAssignment: { storageDtype: 'char8' },
} as typeof DEFAULT_STATE.variables[0];

const CASES = [
  { name: 'default 3-var', state: DEFAULT_STATE },
  { name: 'with text var', state: { ...DEFAULT_STATE, variables: [...DEFAULT_STATE.variables, TEXT_VAR] } },
  { name: 'zero variables', state: { ...DEFAULT_STATE, variables: [] } },
];

describe('values-stage layout equivalence', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const values = computeValuesStage(c.state.shape, c.state.variables);
      const layout = buildValueBlocksLayout(
        c.state.variables, c.state.shape, values.variableValues,
        (name) => (values.variableValues.get(name) ?? []).some((v) => typeof v === 'string') ? 'text' : 'float64',
      );
      expectTraceEquivalence(layout, { values: values.variableValues, format: 'logical' }, values.stage.traces);
    });
  }
});

describe('typed-stage layout equivalence', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const values = computeValuesStage(c.state.shape, c.state.variables);
      const typed = computeTypedStage(c.state.shape, c.state.variables, values.variableValues);
      const layout = buildValueBlocksLayout(
        c.state.variables, c.state.shape, typed.typedVariableValues,
        (name) => c.state.variables.find((v) => v.name === name)!.typeAssignment.storageDtype,
      );
      expectTraceEquivalence(layout, { values: typed.typedVariableValues, format: 'typed' }, typed.stage.traces);
    });
  }
});

describe('traceAt bounds', () => {
  it('returns null out of range', () => {
    const values = computeValuesStage(DEFAULT_STATE.shape, DEFAULT_STATE.variables);
    const layout = buildValueBlocksLayout(DEFAULT_STATE.variables, DEFAULT_STATE.shape, values.variableValues, () => 'float64');
    const sources = { values: values.variableValues, format: 'logical' as const };
    expect(traceAt(layout, -1, sources)).toBeNull();
    expect(traceAt(layout, layout.byteLength, sources)).toBeNull();
  });
});
