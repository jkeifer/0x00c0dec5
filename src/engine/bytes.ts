/**
 * Byte utility helpers shared across the engine.
 *
 * Per remediation-plan.md decision D7, this module is the single source of
 * truth for hex<->byte conversions, byte concatenation, and byte-count
 * formatting (Phase 3.6).
 */

/**
 * Parse a hex string (e.g. "00C0DEC5") into bytes.
 *
 * Tolerant: strips all non-hex characters (whitespace, separators, stray
 * letters outside a-f) before parsing, and if the cleaned string has an odd
 * length, drops the trailing nibble rather than throwing. This makes the
 * parser safe to call on live, in-progress user input.
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, '');
  const evenLength = cleaned.length - (cleaned.length % 2);
  const trimmed = cleaned.slice(0, evenLength);
  const bytes = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < trimmed.length; i += 2) {
    bytes[i / 2] = parseInt(trimmed.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Serialize bytes to a lowercase hex string with no separators. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Concatenate a list of byte arrays into a single new Uint8Array. */
export function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * Format a byte count as a human-readable string — the single formatting
 * authority (D7).
 *
 * The 4 pre-consolidation implementations did not all agree:
 *   - viewerUtils.formatFileSize (removed, UI-10 dead-code cleanup) /
 *     FileExplorer.tsx (now imports formatByteCount directly): "N B" /
 *     "N.N KB" / "N.N MB" (three tiers, space before unit).
 *   - PipelineStrip.tsx (1 call site): "N B" / "N.N KB" (two tiers, space).
 *   - HoverBar.tsx (1 call site): "NB" / "N.NKB" (two tiers, NO space).
 * PipelineStrip and HoverBar (named in D7/UI-11 as the pair to prefer if
 * they agree) differ on the space before the unit, so they don't actually
 * agree with each other — falling through to the "most call sites" rule:
 * the three-tier, space-separated shape (viewerUtils/FileExplorer) wins 2-1-1.
 */
export function formatByteCount(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
