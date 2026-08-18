import type { CodecStep } from '../types/codecs.ts';
import type { DtypeKey } from '../types/dtypes.ts';
import { activeSteps, CODEC_REGISTRY, outputDtypeFor } from './codecs.ts';

/**
 * Reverse a codec pipeline: decode encoded bytes back to original dtype.
 *
 * We build a dtype chain forward via `outputDtypeFor` — the single source of
 * truth for the flow rule (CLAUDE.md pitfall 3) — then decode in reverse.
 * This used to re-implement that rule inline as "entropy → uint8, everything
 * else preserves", which silently went stale the moment the shuffles started
 * degrading to uint8 too.
 */
export function reverseCodecPipeline(
  encodedBytes: Uint8Array,
  steps: CodecStep[],
  originalDtype: DtypeKey,
): { bytes: Uint8Array; outputDtype: string } {
  steps = activeSteps(steps);
  if (steps.length === 0) {
    return { bytes: encodedBytes, outputDtype: originalDtype };
  }

  // 1. Build dtype chain forward: [originalDtype, afterStep0, afterStep1, ...]
  const dtypeChain: DtypeKey[] = [originalDtype];
  let currentDtype: DtypeKey = originalDtype;
  for (const step of steps) {
    const codec = CODEC_REGISTRY[step.codec];
    if (codec) currentDtype = outputDtypeFor(codec, currentDtype);
    dtypeChain.push(currentDtype);
  }

  // 2. Reverse steps and decode
  let bytes = encodedBytes;
  let decodeDtype: DtypeKey = dtypeChain[dtypeChain.length - 1];

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const codec = CODEC_REGISTRY[step.codec];
    if (!codec) continue;

    bytes = codec.decode(bytes, decodeDtype, step.params).bytes;
    // Undoing step i puts the stream back in the state it was in before step i
    // ran, whatever that was — the chain already knows. (This replaces an
    // entropy-only special case that happened to agree with `result.outputDtype`
    // for every other codec, which is no longer true for the shuffles.)
    decodeDtype = dtypeChain[i];
  }

  return { bytes, outputDtype: decodeDtype };
}
