import type { VirtualFile, ReadFailureReason } from '../types/pipeline.ts';
import { deserializeMetadata, serializeMetadataBinary, type MetadataEntry } from './metadata.ts';

type LocateResult =
  | { entries: MetadataEntry[]; chunkDataStart: number; found: string }
  | { entries: null; reason: ReadFailureReason; found: string };

/**
 * Locate metadata entries: sidecar file first, then embedded (single-file
 * mode only) via trailer, header, or footer scan. `chunkDataStart` (D3) is
 * the byte offset where chunk data starts within a single data file, past
 * the leading magic and (header placement only) the header metadata itself
 * — 0 for sidecar/footer/trailer placements, which have no header.
 */
export function locateMetadata(
  files: VirtualFile[],
  dataFiles: VirtualFile[],
  magicBytes: Uint8Array,
): LocateResult {
  const sidecarFile = files.find((f) => f.name === 'metadata');
  // D1: set when a best-effort scan (trailer probe or backward scan) found
  // *something* structured but couldn't turn it into usable entries — that's
  // 'metadata-not-found' (metadata was written, the locator/scan just failed),
  // as opposed to 'no-metadata' (no evidence metadata was ever written).
  let foundPlausibleButUnparseable = false;

  if (sidecarFile && sidecarFile.bytes.length > 0) {
    try {
      const entries = deserializeMetadata(sidecarFile.bytes);
      if (entries.length > 0) return { entries, chunkDataStart: 0, found: `sidecar file "${sidecarFile.name}"` };
      return { entries: null, reason: 'no-metadata', found: 'sidecar file present but empty' };
    } catch {
      // Sidecar bytes existed but failed to parse as metadata at all -> the
      // metadata is corrupt, not absent.
      return { entries: null, reason: 'corrupt-metadata', found: 'sidecar file present but unparseable' };
    }
  }

  if (dataFiles.length === 1) {
    const dataBytes = stripMagic(dataFiles[0].bytes, magicBytes);

    // D1 trailer path: try this first, unconditionally — it's self-describing
    // (a valid trailer is recognizable by construction: last 4 bytes-before-
    // magic decode to a length that exactly reaches a parseable metadata
    // blob) and works identically for JSON and binary. Only footer-placement
    // with footerLocator='trailer' ever produces one, but the reader doesn't
    // (and per D2 shouldn't need to) know the write-side config — it just
    // looks for the trailer shape.
    const trailerResult = tryParseTrailerMetadata(dataBytes);
    if (trailerResult.entries) return { entries: trailerResult.entries, chunkDataStart: 0, found: `trailer-located metadata at end of file` };
    if (trailerResult.plausible) foundPlausibleButUnparseable = true;

    const headerResult = tryParseEmbeddedMetadata(dataBytes, 'header');
    if (headerResult.entries) {
      return { entries: headerResult.entries, chunkDataStart: headerResult.headerByteLength ?? 0, found: 'header at offset 0' };
    }
    if (headerResult.plausible) foundPlausibleButUnparseable = true;

    const footerResult = tryParseEmbeddedMetadata(dataBytes, 'footer');
    if (footerResult.entries) return { entries: footerResult.entries, chunkDataStart: 0, found: 'footer at end of file' };
    if (footerResult.plausible) foundPlausibleButUnparseable = true;
  }

  // D1: a best-effort scan found plausible-but-unparseable structure ->
  // metadata was written but the locator/scanner couldn't pin it down
  // exactly (the intended lesson for footerLocator='none'). Otherwise there
  // is no evidence metadata was ever written (metadata.enabled=false).
  return {
    entries: null,
    reason: foundPlausibleButUnparseable ? 'metadata-not-found' : 'no-metadata',
    found: foundPlausibleButUnparseable
      ? 'scan found plausible-but-unparseable structure'
      : 'no sidecar file and no embedded metadata found',
  };
}

/** Verify a file's leading and trailing magic bytes (write.ts always ends a
 * file with the same magic it started with). Never strips bytes, only checks. */
export function verifyMagic(fileBytes: Uint8Array, magic: Uint8Array): boolean {
  if (magic.length === 0) return true;
  if (fileBytes.length < magic.length * 2) return false;
  for (let i = 0; i < magic.length; i++) {
    if (fileBytes[i] !== magic[i]) return false;
  }
  const end = fileBytes.length - magic.length;
  for (let i = 0; i < magic.length; i++) {
    if (fileBytes[end + i] !== magic[i]) return false;
  }
  return true;
}

/** Strip leading/trailing magic bytes. Only called after `verifyMagic` has
 * confirmed the magic actually matches. */
export function stripMagic(fileBytes: Uint8Array, magic: Uint8Array): Uint8Array {
  if (magic.length === 0) return fileBytes;
  const start = magic.length;
  const end = fileBytes.length - magic.length;
  if (end <= start) return new Uint8Array(0);
  return fileBytes.slice(start, end);
}

/** Describe a magic mismatch for the step log: actual leading bytes vs expected, as hex. */
export function describeMagicMismatch(fileBytes: Uint8Array, magic: Uint8Array): string {
  const actual = Array.from(fileBytes.slice(0, magic.length)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const expected = Array.from(magic).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `leading bytes 0x${actual} do not match expected 0x${expected}`;
}

/** Result of a best-effort metadata scan: either usable entries, or a signal
 * that *something* structured was spotted but couldn't be turned into
 * entries (D1: distinguishes 'metadata-not-found' from 'no-metadata').
 * `headerByteLength` (HEADER-position finds only) is the byte length the
 * located metadata occupied at the start of `dataBytes`, needed when there's
 * no chunk_index to read a real chunk-data-start offset from. */
interface ScanResult {
  entries: MetadataEntry[] | null;
  plausible: boolean;
  headerByteLength?: number;
}

const NOT_FOUND: ScanResult = { entries: null, plausible: false };

/**
 * D1/D4: best-effort embedded-metadata scan, used as the `footerLocator='none'`
 * fallback (and symmetrically for header placement, which has always been
 * locator-free since the header's own start is unambiguous). Deliberately
 * best-effort and kept honest — string-literal-aware JSON brace scan plus a
 * bounded binary plausibility scan, and stops there. No further heuristics.
 */
function tryParseEmbeddedMetadata(
  dataBytes: Uint8Array,
  position: 'header' | 'footer',
): ScanResult {
  if (dataBytes.length === 0) return NOT_FOUND;

  try {
    if (position === 'header') {
      if (dataBytes[0] === 0x7b) {
        const text = new TextDecoder().decode(dataBytes);
        const endIdx = findJsonObjectEnd(text, 0);
        if (endIdx > 0) {
          const jsonBytes = new TextEncoder().encode(text.slice(0, endIdx));
          try {
            const entries = deserializeMetadata(jsonBytes);
            if (entries.length > 0) return { entries, plausible: true, headerByteLength: jsonBytes.length };
          } catch {
            return { entries: null, plausible: true };
          }
        }
        return { entries: null, plausible: true };
      }
      return scanBinaryForward(dataBytes, 0);
    } else {
      if (dataBytes[dataBytes.length - 1] === 0x7d) {
        const text = new TextDecoder().decode(dataBytes);
        const lastBrace = text.lastIndexOf('}');
        const startIdx = lastBrace >= 0 ? findJsonObjectStart(text, lastBrace) : -1;
        if (startIdx >= 0) {
          const jsonStr = text.slice(startIdx, lastBrace + 1);
          const jsonBytes = new TextEncoder().encode(jsonStr);
          try {
            const entries = deserializeMetadata(jsonBytes);
            if (entries.length > 0) return { entries, plausible: true };
          } catch {
            return { entries: null, plausible: true };
          }
        }
        return { entries: null, plausible: false };
      }
      return scanBinaryBackward(dataBytes);
    }
  } catch {
    return NOT_FOUND;
  }
}

/**
 * D1 trailer layout: [magic][chunks][metadata][u32 LE metadata-length][magic].
 * `dataBytes` has its outer magic already stripped, so a trailer — if present
 * — occupies its last 4 bytes (the length). Self-describing: a real trailer
 * is recognized by the length actually reaching back to a byte offset that
 * parses as metadata; this essentially never fires for files without one.
 */
function tryParseTrailerMetadata(dataBytes: Uint8Array): ScanResult {
  if (dataBytes.length < 4) return NOT_FOUND;
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  const len = view.getUint32(dataBytes.length - 4, true);
  if (len <= 0 || len > dataBytes.length - 4) return NOT_FOUND;
  const metaStart = dataBytes.length - 4 - len;
  const metaBytes = dataBytes.slice(metaStart, dataBytes.length - 4);
  try {
    const entries = deserializeMetadata(metaBytes);
    if (entries.length > 0) return { entries, plausible: true };
  } catch {
    // A 4-byte trailer-length read is a coincidence of ordinary chunk data
    // often enough that a parse failure alone isn't "plausible" — only report
    // plausible when the byte before the length also looks like a metadata
    // terminator ('}' for JSON, or a trailer-consistent binary frame).
    if (metaBytes.length > 0 && (metaBytes[metaBytes.length - 1] === 0x7d || looksLikeBinaryMetadataHeader(metaBytes))) {
      return { entries: null, plausible: true };
    }
  }
  return NOT_FOUND;
}

function looksLikeBinaryMetadataHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  return count > 0 && count < 1000;
}

/**
 * Binary "entry-count plausibility scan", forward direction (header
 * placement — binary metadata always starts with its 4-byte entry count, so
 * this is a direct attempt, not really a scan; "plausible" means a small
 * positive count that also parses).
 */
function scanBinaryForward(dataBytes: Uint8Array, start: number): ScanResult {
  if (dataBytes.length - start < 4) return NOT_FOUND;
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  const count = view.getUint32(start, true);
  if (count <= 0 || count >= 1000) return NOT_FOUND;
  try {
    const entries = deserializeMetadata(dataBytes.slice(start));
    if (entries.length > 0) {
      // Binary framing has no terminator either — re-serialize to learn how
      // many bytes the header metadata actually occupied, since there's no
      // chunk_index to read a real chunk-data-start offset from otherwise.
      const headerByteLength = start + serializeMetadataBinary(entries).length;
      return { entries, plausible: true, headerByteLength };
    }
    return { entries: null, plausible: true };
  } catch {
    return { entries: null, plausible: true };
  }
}

/**
 * D1: binary "entry-count plausibility scan", backward direction (footer
 * placement with `footerLocator='none'` — no trailer/index to consult). This
 * is the deliberate failure case D1 calls out: binary metadata has no
 * self-describing terminator the way JSON has a closing `}`, so there is no
 * honest way to pin down where it *starts* by inspecting bytes alone — that's
 * the lesson, not a bug. Checks only a small bounded window near the end for
 * an entry-count-shaped value and never treats a match as a real find; it
 * just reports plausibility, distinguishing 'metadata-not-found' from
 * 'no-metadata'.
 */
const BINARY_PLAUSIBILITY_WINDOW = 64;

function scanBinaryBackward(dataBytes: Uint8Array): ScanResult {
  if (dataBytes.length < 4) return NOT_FOUND;
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  const lo = Math.max(0, dataBytes.length - BINARY_PLAUSIBILITY_WINDOW);
  for (let start = dataBytes.length - 4; start >= lo; start--) {
    const count = view.getUint32(start, true);
    if (count > 0 && count < 1000) {
      return { entries: null, plausible: true };
    }
  }
  return NOT_FOUND;
}

/** Find the index just past the closing `}` of the JSON object starting at
 * `startIdx`, tracking string-literal/escape state so unescaped `{`/`}`
 * *inside* string values (task 2.4 / RP-2 — e.g. a custom metadata value like
 * `weird { value`) don't perturb the brace count. Returns -1 if unbalanced. */
function findJsonObjectEnd(text: string, startIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Counterpart of `findJsonObjectEnd`: given the index of a closing `}`,
 * find the matching opening `{`. String-literal-aware for the same reason
 * (RP-2's backward footer scan was equally brace-blind) — but note this
 * scans '{' occurrences FORWARD from the start of `text`, not backward from
 * `endIdx`: a nested value that is itself a JSON-encoded string (e.g.
 * `variable_statistics`'s stringified object) can look like a perfectly
 * balanced top-level span in isolation, since starting a fresh scan at its
 * '{' has no way to know it's really inside an outer string. The true
 * top-level object always starts at or before any such false candidate, so
 * taking the first forward match that lands exactly on `endIdx` is reliable.
 * Returns -1 if unbalanced. */
function findJsonObjectStart(text: string, endIdx: number): number {
  for (let i = 0; i <= endIdx; i++) {
    if (text[i] !== '{') continue;
    const candidateEnd = findJsonObjectEnd(text, i);
    if (candidateEnd === endIdx + 1) {
      return i;
    }
  }
  return -1;
}
