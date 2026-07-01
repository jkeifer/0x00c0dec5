/**
 * Byte utility helpers shared across the engine.
 *
 * Per remediation-plan.md decision D7, this module is the single source of
 * truth for hex<->byte conversions. `concatBytes`/`formatByteCount` are
 * intentionally NOT here yet — they consolidate in Phase 3.6.
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
