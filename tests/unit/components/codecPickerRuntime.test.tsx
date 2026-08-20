// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CodecPipelineEditor } from '../../../src/components/config/CodecPipelineEditor.tsx';

const REGISTRY_ORDER = ['quantize', 'bitround', 'delta', 'zigzag', 'byte-shuffle', 'bit-shuffle', 'dictionary', 'rle', 'deflate', 'gzip', 'zstd'];
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

// The `elementSize` seed (SW-7, generalized to Delta): a step is added with the
// element size the bytes will actually have at that point in the pipeline, so
// the field shows a concrete number and never a magic "auto".
describe('elementSize seeding on add', () => {
  function addAfter(steps: { codec: string; params: Record<string, number | string> }[], inputDtype: 'float32' | 'int16', codecKey: string) {
    const onChange = vi.fn();
    const { container } = render(
      <CodecPipelineEditor steps={steps} inputDtype={inputDtype} onChange={onChange} />,
    );
    const select = Array.from(container.querySelectorAll('select')).at(-1)!;
    fireEvent.change(select, { target: { value: codecKey } });
    const added = onChange.mock.calls[0][0].at(-1);
    return added.params.elementSize;
  }

  it('seeds from the input dtype size on an empty pipeline', () => {
    expect(addAfter([], 'float32', 'delta')).toBe(4);
    expect(addAfter([], 'int16', 'delta')).toBe(2);
    expect(addAfter([], 'int16', 'byte-shuffle')).toBe(2);
  });

  it('seeds 1 after a byte shuffle, whose declared dtype is stale', () => {
    const shuffled = [{ codec: 'byte-shuffle', params: { elementSize: 4 } }];
    // The dtype flow still says float32/int32 here — only traceMode knows the
    // bytes are byte planes now. Both must seed 1, which is why "not an int"
    // would not have been enough.
    expect(addAfter(shuffled, 'float32', 'delta')).toBe(1);
    expect(addAfter(shuffled, 'int16', 'delta')).toBe(1);
  });

  it('seeds 1 after an entropy codec, whose output really is uint8', () => {
    expect(addAfter([{ codec: 'rle', params: {} }], 'float32', 'delta')).toBe(1);
  });
});
