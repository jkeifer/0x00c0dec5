// @vitest-environment jsdom
//
// PERF-1 sub-finding: an ok:false FIRST compute must surface the error, not
// leave the "starting…" screen up forever. BootScreen is the pre-first-result
// branch of MainLayout, extracted so this contract is testable without the
// full provider stack.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BootScreen } from '../../../src/components/layout/App.tsx';

describe('BootScreen', () => {
  it('shows the booting message when there is no error', () => {
    render(<BootScreen error={null} />);
    expect(screen.getByTestId('pipeline-booting').textContent).toContain('starting');
    expect(screen.queryByTestId('pipeline-boot-error')).toBeNull();
  });

  it('shows the worker error and recovery hint instead of "starting…" when the first compute failed', () => {
    render(<BootScreen error="Data cannot be cloned, out of memory." />);
    expect(screen.queryByTestId('pipeline-booting')).toBeNull();
    const el = screen.getByTestId('pipeline-boot-error');
    expect(el.textContent).toContain('pipeline failed to start');
    expect(el.textContent).toContain('Data cannot be cloned, out of memory.');
    expect(el.textContent).toContain('Clear');
  });
});
