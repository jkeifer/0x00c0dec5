import type { VirtualFile, ReadFailureReason } from '../types/pipeline.ts';
import { deserializeMetadata, type MetadataEntry } from './metadata.ts';
import { decodeMetadataBinary } from './metadataBinary.ts';

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
  // Binary metadata (metadataBinary.ts) opens with a u16 LE entry count.
  if (bytes.length < 2) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(0, true);
  return count > 0 && count < 1000;
}

/**
 * Binary "entry-count plausibility scan", forward direction (header
 * placement — binary metadata always starts with its u16 entry count, so this
 * is a direct attempt, not really a scan; "plausible" means a small positive
 * count). On a plausible count we run the real decoder, which reports exactly
 * how many bytes the header consumed via `bytesConsumed` — the tag framing is
 * self-delimiting per record, so no re-serialize trick is needed.
 *
 * A binary header sits at offset 0 and, if written, is never truncated by the
 * chunk data that follows it, so a real header always decodes. We therefore
 * only report a find (or "plausible") when the decode actually succeeds: a
 * plausible-looking u16 count that then fails to decode is indistinguishable
 * from ordinary chunk bytes at offset 0 (e.g. a 3-byte chunk whose first two
 * bytes read as a small count), and treating that as "metadata present but
 * unparseable" would misreport every such file as metadata-not-found. This is
 * stricter than the old u32 heuristic only because a u16 count is far more
 * common in raw bytes; the intent (report a genuinely-present header) is the
 * same.
 */
function scanBinaryForward(dataBytes: Uint8Array, start: number): ScanResult {
  if (dataBytes.length - start < 2) return NOT_FOUND;
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  const count = view.getUint16(start, true);
  if (count <= 0 || count >= 1000) return NOT_FOUND;
  try {
    const { entries, bytesConsumed } = decodeMetadataBinary(dataBytes.slice(start));
    if (entries.length > 0) {
      return {
        entries: entries.map(({ key, value }) => ({ key, value })),
        plausible: true,
        headerByteLength: start + bytesConsumed,
      };
    }
  } catch {
    // Plausible count but no valid frame — chunk noise, not a header.
  }
  return NOT_FOUND;
}

/**
 * D1: binary "entry-count plausibility scan", backward direction (footer
 * placement with `footerLocator='none'` — no trailer/index to consult). This
 * is the deliberate failure case D1 calls out: binary metadata's start is not
 * self-describing (unlike JSON's closing `}`, the tag framing gives no marker
 * you can find by scanning backward from the end), so there is no honest way
 * to pin down where it *starts* by inspecting bytes alone — that's the lesson,
 * not a bug. It NEVER returns entries; at most it reports plausibility, which
 * only upgrades the failure reason from 'no-metadata' to 'metadata-not-found'.
 *
 * A bare u16 count in 1..999 is far too weak a signal — such a value occurs
 * constantly in raw chunk data, so keying on it alone would report every
 * chunk-only file as "metadata written but unlocatable" (the old u32-count
 * heuristic only avoided this by the count-shaped value being much rarer, i.e.
 * by accident). Instead we require a candidate offset where the full tag
 * framing decodes cleanly AND consumes to exactly end-of-data: that is the
 * shape real footer='none' binary metadata has — it runs to the end, before
 * the already-stripped trailing magic — and that pure chunk data essentially
 * never accidentally forms. We still refuse to return the decoded entries: the
 * point is a reader can't KNOW this candidate is the metadata versus a
 * coincidence without a first-class locator (trailer/index), so the honest
 * outcome is metadata-not-found, not a successful read. Scans every offset (no
 * fixed window) because the metadata can be arbitrarily far from the end;
 * read is not on a hot path and files here are small.
 */
function scanBinaryBackward(dataBytes: Uint8Array): ScanResult {
  if (dataBytes.length < 2) return NOT_FOUND;
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  for (let start = dataBytes.length - 2; start >= 0; start--) {
    const count = view.getUint16(start, true);
    if (count <= 0 || count >= 1000) continue;
    try {
      const { entries, bytesConsumed } = decodeMetadataBinary(dataBytes.slice(start));
      if (entries.length > 0 && bytesConsumed === dataBytes.length - start) {
        return { entries: null, plausible: true };
      }
    } catch {
      // Not a real frame at this offset — keep scanning.
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
