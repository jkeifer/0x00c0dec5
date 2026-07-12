// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CodecPipelineEditor } from '../../../src/components/config/CodecPipelineEditor.tsx';

const REGISTRY_ORDER = ['delta', 'zigzag', 'byte-shuffle', 'bit-shuffle', 'dictionary', 'rle', 'deflate', 'gzip', 'zstd'];
const PYODIDE_KEYS = ['deflate', 'gzip', 'zstd'];

function renderEditor(runtimeStatus?: 'loading' | 'ready' | 'error') {
  const onChange = vi.fn();
  const utils = render(
    <CodecPipelineEditor steps={[]} inputDtype="float32" onChange={onChange} runtimeStatus={runtimeStatus} />,
  );
  const select = utils.container.querySelector('select')!;
  return { onChange, select, ...utils };
}

describe('codec picker flat list', () => {
  it('renders a single flat option list with no optgroups, in registry insertion order', () => {
    const { select } = renderEditor('ready');
    expect(select.querySelectorAll('optgroup').length).toBe(0);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    // First option is the "+ Add codec" placeholder, then registry order.
    expect(values).toEqual(['', ...REGISTRY_ORDER]);
  });

  it('disables pyodide-backed codecs while loading, enables when ready', () => {
    const loading = renderEditor('loading');
    for (const key of PYODIDE_KEYS) {
      const opt = loading.select.querySelector(`option[value="${key}"]`) as HTMLOptionElement;
      expect(opt.disabled).toBe(true);
      expect(opt.textContent).toContain('(loading…)');
    }
    const ready = renderEditor('ready');
    for (const key of PYODIDE_KEYS) {
      const opt = ready.select.querySelector(`option[value="${key}"]`) as HTMLOptionElement;
      expect(opt.disabled).toBe(false);
      expect(opt.textContent).not.toContain('(loading…)');
      expect(opt.textContent).not.toContain('(unavailable)');
    }
    const errored = renderEditor('error');
    for (const key of PYODIDE_KEYS) {
      const opt = errored.select.querySelector(`option[value="${key}"]`) as HTMLOptionElement;
      expect(opt.disabled).toBe(true);
      expect(opt.textContent).toContain('(unavailable)');
    }
  });

  it('local (non-pyodide) codecs are always enabled regardless of runtime status', () => {
    const localKeys = REGISTRY_ORDER.filter((k) => !PYODIDE_KEYS.includes(k));
    for (const status of ['loading', 'ready', 'error'] as const) {
      const { select } = renderEditor(status);
      for (const key of localKeys) {
        const opt = select.querySelector(`option[value="${key}"]`) as HTMLOptionElement;
        expect(opt.disabled).toBe(false);
      }
    }
  });

  it('defaults to ready when the prop is omitted (existing callers unchanged)', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodecPipelineEditor steps={[]} inputDtype="float32" onChange={onChange} />,
    );
    const select = container.querySelector('select')!;
    const zstdOpt = select.querySelector('option[value="zstd"]') as HTMLOptionElement;
    expect(zstdOpt.disabled).toBe(false);
    fireEvent.change(select, { target: { value: 'zstd' } });
    expect(onChange).toHaveBeenCalledWith([
      { codec: 'zstd', params: { level: 3 } },
    ]);
  });
});
