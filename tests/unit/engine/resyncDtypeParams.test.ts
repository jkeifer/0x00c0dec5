import { describe, it, expect } from 'vitest';
import { resyncDtypeParams } from '../../../src/engine/codecs.ts';
import type { CodecStep } from '../../../src/types/codecs.ts';

const delta = (elementSize: number): CodecStep => ({ codec: 'delta', params: { elementSize } });

describe('resyncDtypeParams', () => {
  it('follows the input dtype width for a single element-sized codec', () => {
    // Seeded wrong (1), int16 flowing in → 2.
    const out = resyncDtypeParams([delta(1)], 'int16');
    expect(out[0].params.elementSize).toBe(2);
  });

  it('follows the running dtype after an upstream entropy codec (uint8 → size 1)', () => {
    // Delta added after deflate is seeded 2 (matching int16); after deflate the
    // stream is uint8, so delta's element size should re-sync to 1.
    const steps: CodecStep[] = [{ codec: 'deflate', params: {} }, delta(2)];
    const out = resyncDtypeParams(steps, 'int16');
    expect(out[1].params.elementSize).toBe(1);
  });

  it('treats a disabled upstream step as a pass-through', () => {
    const steps: CodecStep[] = [{ codec: 'deflate', params: {}, enabled: false }, delta(1)];
    const out = resyncDtypeParams(steps, 'int16');
    // deflate disabled → delta still sees int16 → size 2.
    expect(out[1].params.elementSize).toBe(2);
  });

  it('re-derives Scale/Offset sourceDtype from the input dtype', () => {
    const steps: CodecStep[] = [
      { codec: 'scale-offset', params: { scale: 10, targetDtype: 'int16', sourceDtype: 'float32' } },
    ];
    const out = resyncDtypeParams(steps, 'float64');
    expect(out[0].params.sourceDtype).toBe('float64');
  });

  it('returns the same step object when already in sync (no needless churn)', () => {
    const steps = [delta(2)];
    const out = resyncDtypeParams(steps, 'int16');
    expect(out[0]).toBe(steps[0]);
  });

  it('leaves params without dtype-following keys untouched', () => {
    const steps: CodecStep[] = [{ codec: 'quantize', params: { step: 0.5 } }];
    const out = resyncDtypeParams(steps, 'float32');
    expect(out[0]).toBe(steps[0]);
  });
});
