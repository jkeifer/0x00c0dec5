import type { ReadStep, ReadStepId, ReadFailureReason, ReadFileResult } from '../types/pipeline.ts';

/**
 * Fixed 8-step order the reader narrates through on every read, success or
 * failure (read plan Task 2) — the single source of truth for step identity,
 * display label, and what the reader "needs" at that step, mirroring how a
 * real-format reader proceeds: verify magic, locate metadata, parse it, read
 * the schema and layout it describes, locate chunks, decode them, reassemble
 * values.
 */
export const READ_STEP_ORDER: { id: ReadStepId; label: string; needed: string }[] = [
  {
    id: 'verify-magic',
    label: 'Verify magic number',
    needed: "The file's leading (and trailing) bytes must match this reader's expected magic number.",
  },
  {
    id: 'locate-metadata',
    label: 'Locate metadata',
    needed: 'Metadata describing the dataset must be found — as a sidecar file, or embedded via header, footer, or trailer.',
  },
  {
    id: 'parse-metadata',
    label: 'Parse metadata',
    needed: 'Located metadata bytes must parse into a usable set of entries (valid JSON or binary framing).',
  },
  {
    id: 'read-schema',
    label: 'Read schema',
    needed: "The parsed entries must describe the dataset's variables and their dtypes.",
  },
  {
    id: 'read-layout',
    label: 'Read layout',
    needed: 'The parsed entries must describe the shape, chunk shape, and interleaving used to write the data.',
  },
  {
    id: 'locate-chunks',
    label: 'Locate chunks',
    needed: "Each chunk's byte offset and size must be known or computable, so its encoded bytes can be read.",
  },
  {
    id: 'decode-chunks',
    label: 'Decode chunks',
    needed: "Each chunk's bytes must reverse cleanly through its codec pipeline back to typed values.",
  },
  {
    id: 'reassemble',
    label: 'Reassemble values',
    needed: 'Decoded chunk values must scatter into their correct global positions to reconstruct each variable.',
  },
];

/**
 * Tracks progress through `READ_STEP_ORDER` as `readFile` proceeds.
 * `fail()` marks the given step failed and fills every remaining step
 * 'skipped' (the reader never got to try them). `finish()` is used on the
 * success path, once every step has actually been recorded ok.
 */
export interface StepRecorder {
  ok(id: ReadStepId, found: string, detail?: string): void;
  fail(id: ReadStepId, found: string, detail: string): ReadStep[];
  finish(): ReadStep[];
}

export function createStepRecorder(): StepRecorder {
  const recorded = new Map<ReadStepId, ReadStep>();

  function stepFor(id: ReadStepId, found: string, outcome: ReadStep['outcome'], detail?: string): ReadStep {
    const spec = READ_STEP_ORDER.find((s) => s.id === id)!;
    return { id: spec.id, label: spec.label, needed: spec.needed, found, outcome, detail };
  }

  return {
    ok(id, found, detail) {
      recorded.set(id, stepFor(id, found, 'ok', detail));
    },
    fail(id, found, detail) {
      recorded.set(id, stepFor(id, found, 'failed', detail));
      for (const spec of READ_STEP_ORDER) {
        if (!recorded.has(spec.id)) {
          recorded.set(spec.id, stepFor(spec.id, 'not reached', 'skipped'));
        }
      }
      return READ_STEP_ORDER.map((spec) => recorded.get(spec.id)!);
    },
    finish() {
      // Dev-time invariant: every step must have been recorded before a
      // success result is returned — a step silently skipped on the success
      // path is a bug in the threading, not a valid state to hide.
      const missing = READ_STEP_ORDER.filter((spec) => !recorded.has(spec.id));
      if (missing.length > 0) {
        throw new Error(
          `createStepRecorder.finish(): missing step(s) ${missing.map((s) => s.id).join(', ')} — ` +
          `every step must be recorded ok before a success result is returned.`,
        );
      }
      return READ_STEP_ORDER.map((spec) => recorded.get(spec.id)!);
    },
  };
}

export const FAILURE_MESSAGES: Record<ReadFailureReason, (byteCount: number, detail?: string) => string> = {
  'no-metadata': (byteCount) =>
    `Cannot read file.\n\n` +
    `The file contains ${byteCount} bytes of data but no metadata describing how to interpret them. ` +
    `A reader needs to know: the variable names and types, the data shape, how the data was chunked ` +
    `and interleaved, and what codecs were applied — in order to reverse the encoding and reconstruct values.\n\n` +
    `Turn on "Enable Metadata" in the Metadata section to make this file self-describing.`,
  'metadata-not-found': (byteCount) =>
    `Cannot read file.\n\n` +
    `The file contains ${byteCount} bytes of data and metadata was written, but this reader's best-effort ` +
    `scan could not locate it. Without a length trailer, a scanner has to guess where structured metadata ` +
    `starts and ends — real formats avoid this by recording an exact length (Parquet ends every file with ` +
    `[footer][4-byte length]['PAR1']).\n\n` +
    `Set the Footer locator to "trailer" so the reader can seek directly to the metadata instead of scanning for it.`,
  'bad-magic': (byteCount) =>
    `Cannot read file.\n\n` +
    `The file's leading bytes (of ${byteCount} total) do not match the expected magic number. ` +
    `This reader only understands files it was built for — exactly as a Parquet reader expects "PAR1" or a ` +
    `TIFF reader expects "II*\\0". A magic-number mismatch means either this isn't the right kind of file, ` +
    `or it was corrupted before the reader ever got to interpret its contents.`,
  'corrupt-metadata': (byteCount, detail) =>
    `Cannot read file.\n\n` +
    `Metadata was located within the ${byteCount} bytes of file data, but it could not be parsed into a ` +
    `usable description of the dataset (missing fields, or malformed JSON/binary structure).` +
    (detail ? ` Underlying error: ${detail}` : '') +
    `\n\nA reader that finds metadata but can't trust its contents has to fail rather than guess at the ` +
    `data's layout.`,
  'no-chunk-index': (byteCount) =>
    `Cannot read file.\n\n` +
    `The file contains ${byteCount} bytes of data using one or more size-changing codecs (e.g. RLE, LZ), ` +
    `so encoded chunk sizes can't be computed from chunk shape and dtype alone — and nothing in the file ` +
    `records where each chunk actually starts.\n\n` +
    `Re-enable the chunk index, or remove the size-changing codecs from the pipeline. This is exactly why ` +
    `real chunked/columnar formats (Zarr, Parquet) always carry an index: variable-size compressed chunks ` +
    `are unlocatable without one.`,
  'decode-error': (byteCount, detail) =>
    `Cannot read file.\n\n` +
    `Metadata for the ${byteCount} bytes of file data was found and parsed successfully, but reconstructing ` +
    `values from it failed while reversing codecs, deinterleaving, or reassembling chunks.` +
    (detail ? ` Underlying error: ${detail}` : '') +
    `\n\nThis usually means the encoded bytes don't actually match what the metadata claims about them ` +
    `(wrong dtype, wrong chunk geometry, or a codec that isn't a true inverse of its encode step).`,
  'missing-schema': (byteCount) =>
    `Cannot read file.\n\n` +
    `Metadata for the ${byteCount} bytes of file data was found and parsed, but nothing describes the ` +
    `variables — their names, storage types, or how logical values were converted for storage. The reader ` +
    `can locate bytes but cannot interpret a single one of them.\n\n` +
    `Enable "Schema" in the Metadata section's include toggles so the file describes its own variables.`,
  'missing-layout': (byteCount) =>
    `Cannot read file.\n\n` +
    `Metadata was found and parsed, and the ${byteCount} bytes of file data describe known variables, but ` +
    `nothing records the dataset's shape, chunk shape, or interleaving. The reader knows what each value ` +
    `means but not how many values there are or how they're arranged — it can't even say where one chunk ` +
    `ends and the next begins.\n\n` +
    `Enable "Layout" in the Metadata section's include toggles so the file describes its own geometry.`,
};

/**
 * Build a failure result. `message` is computed once here and used both as
 * `result.message` and (by every call site, via `recorder.fail`) as the
 * failed step's `detail` — a single source, never two independently-computed
 * strings that could drift apart.
 */
export function makeFailure(
  reason: ReadFailureReason,
  byteCount: number,
  recorder: StepRecorder,
  failedStep: ReadStepId,
  found: string,
  detail?: string,
): ReadFileResult {
  const message = FAILURE_MESSAGES[reason](byteCount, detail);
  return {
    success: false,
    reason,
    message,
    byteCount,
    steps: recorder.fail(failedStep, found, message),
  };
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
