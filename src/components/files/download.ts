/**
 * Export/download helpers for FileExplorer (remediation-plan.md task 6.3).
 *
 * Kept dependency-free per the task: no zip library. Multi-file "download
 * all" just triggers one browser download per VirtualFile, sequentially.
 */

/**
 * Normalize a VirtualFile's name into something safe to hand to `<a
 * download>`. `write.ts` names the single-file-mode output `'data'` (no
 * extension — see `assembleFiles`'s single-file branch, `files.push({ name:
 * 'data', ... })`); an extension-less download is fine on disk but reads
 * oddly and won't hint "open me in a hex editor," so this appends `.bin`
 * only when the name has no `.` in it at all. Per-chunk / metadata sidecar
 * names (e.g. `chunk_0_0`, `metadata.json`) are otherwise used as-is.
 */
export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return 'data.bin';
  return trimmed.includes('.') ? trimmed : `${trimmed}.bin`;
}

/**
 * Trigger a browser download of `bytes` as `filename` via a Blob + object
 * URL + synthetic anchor click, per the standard no-dependency pattern.
 */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  // `bytes.buffer` is typed as `ArrayBufferLike` (could be a SharedArrayBuffer),
  // which `BlobPart` rejects under the DOM lib's stricter typing. `.slice()`
  // always returns a plain ArrayBuffer-backed Uint8Array, satisfying both the
  // type checker and Blob's runtime expectations.
  const blob = new Blob([bytes.slice()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Download every file sequentially. A small delay between anchors gives the
 * browser's download queue time to register each one before the next fires
 * — without it, some browsers silently drop all but the first of a burst of
 * same-tick downloads.
 */
export async function downloadAll(
  files: { name: string; bytes: Uint8Array }[],
  delayMs = 150,
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    downloadBytes(files[i].bytes, normalizeDownloadFilename(files[i].name));
    if (i < files.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
