// @vitest-environment jsdom
//
// The variable color popover's commit discipline: a palette swatch click
// commits that color exactly once, and the "Custom…" native input commits
// only on the DOM `change` event (dialog close) — never on `input` events
// (which fire continuously while dragging in the OS dialog; every commit
// triggers a full worker recompute, so per-drag commits are unacceptable).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VariableColorPicker } from '../../../src/components/config/SchemaEditor.tsx';
import { colors } from '../../../src/theme.ts';

describe('VariableColorPicker', () => {
  it('commits the chosen palette color on swatch click and closes the popover', () => {
    const onCommit = vi.fn();
    render(<VariableColorPicker color={colors.palette[0]} varIdx={0} onCommit={onCommit} />);

    fireEvent.click(screen.getByTestId('variable-color-0'));
    fireEvent.click(screen.getByTestId('variable-color-swatch-3'));

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(colors.palette[3]);
    expect(screen.queryByTestId('variable-color-swatch-3')).toBeNull();
  });

  it('custom input commits on `change` only, never on per-drag `input` events', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <VariableColorPicker color={colors.palette[0]} varIdx={0} onCommit={onCommit} />,
    );

    fireEvent.click(screen.getByTestId('variable-color-0'));
    const input = container.querySelector('input[type="color"]') as HTMLInputElement;

    // Simulate dragging inside the OS dialog: a stream of `input` events.
    input.value = '#111111';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = '#222222';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();

    // Dialog close: one `change` event → exactly one commit.
    input.value = '#123456';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('#123456');
  });
});
