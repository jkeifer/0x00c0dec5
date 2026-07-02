// Regression scenario: file export/download (remediation-plan.md task 6.3).
//
// Verifies the FileExplorer download affordances added in the Write sidebar
// section:
//   - single-file mode: one [data-testid="download-file-0"] button whose
//     click produces a browser download; the downloaded bytes START WITH the
//     configured magic number (default 00 C0 DE C5).
//   - per-chunk mode: multiple file entries, a [data-testid="download-all"]
//     button, and clicking it produces one download per file (captured via
//     Playwright's page.waitForEvent('download') queued before the click).
//
// Run: node tests/ui/scenario-export.mjs   (dev server must be running)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-export');

async function setPartitioning(page, partitioning) {
  const label = partitioning === 'single' ? 'Single file' : 'Per-chunk';
  await page
    .locator('[data-testid="sidebar-section-write"] button', { hasText: new RegExp(`^${label}$`) })
    .click();
  await page.waitForTimeout(400);
}

/** Save a Playwright Download to a temp file and return its bytes as a Buffer. */
async function downloadToBuffer(download) {
  const tmpPath = path.join(os.tmpdir(), `0x00c0dec5-export-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await download.saveAs(tmpPath);
  const buf = fs.readFileSync(tmpPath);
  fs.unlinkSync(tmpPath);
  return buf;
}

async function main() {
  const { browser, page } = await launch();

  // ─── Single-file mode ────────────────────────────────────────────────────
  await setPartitioning(page, 'single');
  await page.waitForTimeout(300);

  const fileExplorerVisible = (await page.locator('[data-testid="file-explorer"]').count()) > 0;
  h.check('file explorer renders in single-file mode', fileExplorerVisible);

  const downloadBtn0 = page.locator('[data-testid="download-file-0"]');
  const hasDownloadBtn0 = (await downloadBtn0.count()) > 0;
  h.check('download-file-0 button is present in single-file mode', hasDownloadBtn0);

  // "Download all" should NOT appear when there's only one file.
  const downloadAllAbsent = (await page.locator('[data-testid="download-all"]').count()) === 0;
  h.check('download-all is absent when only one file exists', downloadAllAbsent);

  await shot(page, 'export-single-file-mode');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadBtn0.click(),
  ]);
  const suggestedName = download.suggestedFilename();
  const bytes = await downloadToBuffer(download);
  const magicHex = bytes.slice(0, 4).toString('hex');

  h.check(
    'single-file download has a sensible (non-empty, dotted) filename',
    suggestedName.length > 0 && suggestedName.includes('.'),
    suggestedName,
  );
  h.check(
    'single-file download bytes START WITH the magic number 00C0DEC5',
    magicHex === '00c0dec5',
    `first 4 bytes = ${magicHex}`,
  );

  // ─── Per-chunk mode ──────────────────────────────────────────────────────
  await setPartitioning(page, 'per-chunk');
  await page.waitForTimeout(400);

  const fileEntryCount = await page.locator('[data-testid^="file-entry-"]').count();
  h.check('per-chunk mode produces more than one file entry', fileEntryCount > 1, `count=${fileEntryCount}`);

  const downloadAllBtn = page.locator('[data-testid="download-all"]');
  const hasDownloadAll = (await downloadAllBtn.count()) > 0;
  h.check('download-all button appears when more than one file exists', hasDownloadAll);

  await shot(page, 'export-per-chunk-mode');

  // Collect one download event per expected file before clicking, since
  // downloadAll() fires them sequentially with a short delay in between.
  const downloadPromises = [];
  for (let i = 0; i < fileEntryCount; i++) {
    downloadPromises.push(page.waitForEvent('download', { timeout: 10000 }));
  }
  await downloadAllBtn.click();
  const downloads = await Promise.all(downloadPromises);

  h.check(
    'download-all produces exactly one download per file',
    downloads.length === fileEntryCount,
    `expected=${fileEntryCount} got=${downloads.length}`,
  );

  // Sanity: every downloaded file has a non-empty name and non-zero byte length.
  let allNamed = true;
  let allNonEmpty = true;
  for (const d of downloads) {
    const name = d.suggestedFilename();
    if (!name || name.length === 0) allNamed = false;
    const buf = await downloadToBuffer(d);
    if (buf.length === 0) allNonEmpty = false;
  }
  h.check('all per-chunk downloads have non-empty filenames', allNamed);
  h.check('all per-chunk downloads have non-zero byte length', allNonEmpty);

  // Also verify per-file download buttons still work individually in per-chunk mode.
  const perFileBtn = page.locator('[data-testid="download-file-0"]');
  const [singleChunkDownload] = await Promise.all([
    page.waitForEvent('download'),
    perFileBtn.click(),
  ]);
  const chunkBytes = await downloadToBuffer(singleChunkDownload);
  h.check(
    'per-chunk individual download-file-0 button works and yields bytes',
    chunkBytes.length > 0,
    `bytes=${chunkBytes.length}`,
  );

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
