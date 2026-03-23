import type { CodecStep } from '../types/codecs.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { CODEC_REGISTRY } from './codecs.ts';

/**
 * Reverse a codec pipeline: decode encoded bytes back to original dtype.
 *
 * With mapping codecs (scale-offset, bitround) removed from the registry,
 * the remaining codecs are:
 * - reordering (delta, byte-shuffle): preserve dtype
 * - entropy (rle, lz): output uint8
 *
 * We build a dtype chain forward, then decode in reverse.
 */
export function reverseCodecPipeline(
  encodedBytes: Uint8Array,
  steps: CodecStep[],
  originalDtype: DtypeKey,
): { bytes: Uint8Array; outputDtype: string } {
  if (steps.length === 0) {
    return { bytes: encodedBytes, outputDtype: originalDtype };
  }

  // 1. Build dtype chain forward: [originalDtype, afterStep0, afterStep1, ...]
  const dtypeChain: string[] = [originalDtype];
  let currentDtype: string = originalDtype;
  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) {
      dtypeChain.push(currentDtype);
      continue;
    }
    if (codec.category === 'entropy') {
      currentDtype = 'uint8';
    }
    // reordering codecs preserve dtype
    dtypeChain.push(currentDtype);
  }

  // 2. Reverse steps and decode
  let bytes = encodedBytes;
  let decodeDtype = dtypeChain[dtypeChain.length - 1];

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;

    const preEncodeDtype = dtypeChain[i]; // dtype before this encode step

    const result = codec.decode(bytes, decodeDtype, step.params);
    bytes = result.bytes;

    // After entropy codec decode, the output is raw bytes (uint8).
    // We know the pre-entropy dtype from the chain, so override.
    if (codec.category === 'entropy') {
      decodeDtype = preEncodeDtype;
    } else {
      decodeDtype = result.outputDtype;
    }
  }

  return { bytes, outputDtype: decodeDtype };
}
