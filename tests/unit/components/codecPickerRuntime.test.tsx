// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CodecPipelineEditor } from '../../../src/components/config/CodecPipelineEditor.tsx';

function renderEditor(runtimeStatus?: 'loading' | 'ready' | 'error') {
  const onChange = vi.fn();
  const utils = render(
    <CodecPipelineEditor steps={[]} inputDtype="float32" onChange={onChange} runtimeStatus={runtimeStatus} />,
  );
  const select = utils.container.querySelector('select')!;
  return { onChange, select, ...utils };
}

describe('codec picker real-codec group', () => {
  it('groups real codecs separately with the numcodecs note', () => {
    const { select } = renderEditor('ready');
    const group = select.querySelector('optgroup[data-testid="codec-group-real"]')!;
    expect(group).not.toBeNull();
    expect(group.getAttribute('label')).toContain('Real codecs');
    const keys = Array.from(group.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(keys).toEqual(['deflate', 'gzip', 'zstd']);
    // Educational groups no longer contain the real entries
    const allOtherKeys = Array.from(select.querySelectorAll('optgroup:not([data-testid="codec-group-real"]) option'))
      .map((o) => o.getAttribute('value'));
    expect(allOtherKeys).not.toContain('zstd');
  });

  it('disables real codecs while loading, enables when ready', () => {
    const loading = renderEditor('loading');
    for (const opt of loading.select.querySelectorAll('optgroup[data-testid="codec-group-real"] option')) {
      expect((opt as HTMLOptionElement).disabled).toBe(true);
    }
    const ready = renderEditor('ready');
    for (const opt of ready.select.querySelectorAll('optgroup[data-testid="codec-group-real"] option')) {
      expect((opt as HTMLOptionElement).disabled).toBe(false);
    }
  });

  it('defaults to ready when the prop is omitted (existing callers unchanged)', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodecPipelineEditor steps={[]} inputDtype="float32" onChange={onChange} />,
    );
    const select = container.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'zstd' } });
    expect(onChange).toHaveBeenCalledWith([
      { codec: 'zstd', params: { level: 3 } },
    ]);
  });
});
