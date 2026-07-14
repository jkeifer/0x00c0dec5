// @vitest-environment jsdom
//
// Task 3 (viewers/hot-paths plan): SchemaEditor's stale ">10K values" warning
// is replaced by a soft cap (SOFT_ELEMENT_CAP) derived from the Phase 1-3
// profiling exit numbers. SchemaEditor is a plain prop-driven component (no
// useAppState() call inside it — verified by reading the source), so unlike
// aboutModal.test.tsx there's no need for AppStateProvider; DEFAULT_VARIABLES
// is reused directly as realistic variable props.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SchemaEditor, SOFT_ELEMENT_CAP } from '../../../src/components/config/SchemaEditor.tsx';
import { DEFAULT_STATE, DEFAULT_VARIABLES } from '../../../src/types/state.ts';

const noop = () => {};

describe('SchemaEditor element cap warning', () => {
  it('is absent when total values are under the soft cap', () => {
    render(
      <SchemaEditor
        variables={DEFAULT_STATE.variables}
        shape={DEFAULT_STATE.shape}
        dataModel={DEFAULT_STATE.dataModel}
        onAddVariable={noop}
        onRemoveVariable={noop}
        onUpdateVariable={noop}
        onShapeChange={noop}
      />,
    );
    expect(screen.queryByTestId('element-cap-warning')).toBeNull();
  });

  it('is present with warning styling and soft-cap copy when total values exceed the cap', () => {
    const shape = [2048, 2048];
    const variables = DEFAULT_VARIABLES; // 3 variables
    const totalValues = shape[0] * shape[1] * variables.length;
    expect(totalValues).toBeGreaterThan(SOFT_ELEMENT_CAP); // 12.6M > 8M

    render(
      <SchemaEditor
        variables={variables}
        shape={shape}
        dataModel="array"
        onAddVariable={noop}
        onRemoveVariable={noop}
        onUpdateVariable={noop}
        onShapeChange={noop}
      />,
    );

    const banner = screen.getByTestId('element-cap-warning');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toMatch(/soft cap|won't stop you|comfortable limit/i);
    expect(banner.style.color).toBeTruthy();
  });
});
