// Regression scenario: metadata placement x serialization matrix, plus the
// D1 footer-locator and D3 chunk-index axes added in Phase 2.
//
// Drives the Write sidebar's "Include Metadata" / "Metadata Placement" /
// "Footer Locator" controls, the Metadata sidebar's JSON/Binary serialization
// toggle and "Include Chunk Index" toggle, and the Codecs sidebar, then
// asserts on [data-testid="read-status"].
//
// FIXED RP-1 (docs/remediation-plan.md Part 1, "Read-path feature gaps"):
// binary metadata + footer placement used to be unreadable because
// tryParseEmbeddedMetadata's footer branch only looked for JSON braces. Phase
// 2 (tasks 2.3/2.4) added the D1 footer-locator trailer path, which is now
// the DEFAULT ('trailer'), so footer+binary is a normal PASS check below —
// no longer a knownFail.
//
// ADDED (D1): footer + locator "none" + binary → read FAILS with the
// trailer-lesson message. This is asserted as a PASS of the pedagogical
// failure (the scanner legitimately can't locate binary metadata without a
// trailer), not a knownFail — it is the intended, documented behavior.
//
// ADDED (D3): chunk-index toggle off + a size-changing codec (RLE) → read
// fails mentioning the chunk index; chunk-index off + no codecs → read still
// succeeds via computed offsets.
//
// Run: node tests/ui/scenario-placement-matrix.mjs   (dev server must be running)

import { launch, shot, createHarness, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-placement-matrix');

const PLACEMENTS = ['header', 'footer', 'sidecar'];
const SERIALIZATIONS = ['json', 'binary'];
const PLACEMENT_LABEL = { header: 'Header', footer: 'Footer', sidecar: 'Sidecar' };
const SERIALIZATION_LABEL = { json: 'JSON', binary: 'Binary' };

async function readStatusText(page) {
  return page.locator('[data-testid="read-status"]').innerText().catch(() => '');
}

async function setIncludeMetadata(page, on) {
  await page
    .locator('[data-testid="metadata-enabled-toggle"] button', { hasText: on ? /^Yes$/ : /^No$/ })
    .click();
  await page.waitForTimeout(500);
}

async function setIncludeChunkIndex(page, on) {
  await page
    .locator('[data-testid="include-chunk-index-toggle"] button', { hasText: on ? /^Yes$/ : /^No$/ })
    .click();
  await page.waitForTimeout(500);
}

async function setPlacement(page, placement) {
  await page
    .locator('[data-testid="sidebar-section-write"] button', { hasText: new RegExp(`^${PLACEMENT_LABEL[placement]}$`) })
    .click();
  await page.waitForTimeout(500);
}

async function setSerialization(page, serialization) {
  await page
    .locator('[data-testid="sidebar-section-metadata"] button', { hasText: new RegExp(`^${SERIALIZATION_LABEL[serialization]}$`) })
    .click();
  await page.waitForTimeout(500);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function setFooterLocator(page, locator) {
  const label = locator === 'trailer' ? 'Length trailer' : 'None (reader must scan)';
  await page
    .locator('[data-testid="footer-locator-toggle"] button', { hasText: new RegExp(`^${escapeRegExp(label)}$`) })
    .click();
  await page.waitForTimeout(500);
}

/** Add RLE to the humidity variable's field pipeline (3rd variable, column
 * mode, the default interleaving) via its "+ Add codec" <select>. */
async function addRleToHumidity(page) {
  const codecsSection = page.locator('[data-testid="sidebar-section-codecs"]');
  const addCodecSelects = codecsSection.locator('select');
  // temperature, pressure, humidity — humidity is the 3rd variable/select.
  await addCodecSelects.nth(2).selectOption('rle');
  await page.waitForTimeout(500);
}

async function main() {
  const { browser, page } = await launch();

  // Turn on include-metadata first — the matrix is meaningless without it.
  await setIncludeMetadata(page, true);
  await waitForPipelineIdle(page);
  const includeOnText = await readStatusText(page);
  h.check(
    'include-metadata ON with default (header/json) reads successfully',
    /File parsed successfully/.test(includeOnText),
    includeOnText.slice(0, 120).replace(/\n/g, ' '),
  );

  for (const serialization of SERIALIZATIONS) {
    await setSerialization(page, serialization);
    for (const placement of PLACEMENTS) {
      await setPlacement(page, placement);
      await waitForPipelineIdle(page);
      const text = await readStatusText(page);
      const success = /File parsed successfully/.test(text);
      const label = `placement=${placement} serialization=${serialization}`;
      await shot(page, `placement-matrix-${placement}-${serialization}`);

      // FIXED RP-1: footerLocator defaults to 'trailer' (D1), which appends a
      // 4-byte LE metadata length before the closing magic and works
      // identically for JSON and binary — footer+binary is a normal PASS now.
      h.check(`${label} → read succeeds`, success, text.slice(0, 120).replace(/\n/g, ' '));
    }
  }

  // ─── D1: footer + locator "none" + binary → the documented failure ───────
  //
  // Reset to a clean footer+binary baseline (still passing, from the loop
  // above via the default 'trailer' locator), then switch the locator to
  // 'none'. Binary metadata has no self-describing terminator to scan for,
  // so this is the deliberate, honest scanner failure D1 calls out — assert
  // it as a PASS of the expected pedagogical outcome, not a knownFail.
  await setSerialization(page, 'binary');
  await setPlacement(page, 'footer');
  await waitForPipelineIdle(page);
  const trailerOnText = await readStatusText(page);
  h.check(
    'footer + binary + locator=trailer (default) → read succeeds',
    /File parsed successfully/.test(trailerOnText),
    trailerOnText.slice(0, 120).replace(/\n/g, ' '),
  );

  await setFooterLocator(page, 'none');
  await waitForPipelineIdle(page);
  const locatorNoneText = await readStatusText(page);
  await shot(page, 'placement-matrix-footer-binary-locator-none');
  h.check(
    'footer + binary + locator=none → read fails with the trailer-lesson message',
    /Read failed/.test(locatorNoneText) &&
      !/File parsed successfully/.test(locatorNoneText) &&
      /trailer/i.test(locatorNoneText),
    locatorNoneText.slice(0, 200).replace(/\n/g, ' '),
  );

  // Restore locator to 'trailer' and reset to header/json for the checks below.
  await setFooterLocator(page, 'trailer');
  await setSerialization(page, 'json');
  await setPlacement(page, 'header');
  await waitForPipelineIdle(page);

  // ─── D3: chunk-index toggle ───────────────────────────────────────────────
  //
  // Chunk-index off + no size-changing codecs (default pipelines are empty)
  // → read still succeeds via computed offsets (chunkShape x dtype size).
  await setIncludeChunkIndex(page, false);
  await waitForPipelineIdle(page);
  const chunkIndexOffText = await readStatusText(page);
  await shot(page, 'placement-matrix-chunk-index-off-no-codecs');
  h.check(
    'chunk-index off + no codecs → read succeeds via computed offsets',
    /File parsed successfully/.test(chunkIndexOffText),
    chunkIndexOffText.slice(0, 160).replace(/\n/g, ' '),
  );

  // Chunk-index off + RLE (a size-changing codec) on humidity → read fails,
  // mentioning the chunk index (D3's "why indexes exist" lesson).
  await addRleToHumidity(page);
  await waitForPipelineIdle(page);
  const chunkIndexOffRleText = await readStatusText(page);
  await shot(page, 'placement-matrix-chunk-index-off-rle');
  h.check(
    'chunk-index off + RLE codec → read fails mentioning the chunk index',
    /Read failed/.test(chunkIndexOffRleText) &&
      !/File parsed successfully/.test(chunkIndexOffRleText) &&
      /chunk index/i.test(chunkIndexOffRleText),
    chunkIndexOffRleText.slice(0, 200).replace(/\n/g, ' '),
  );

  // Restore chunk index on for a clean pedagogical-failure check below.
  await setIncludeChunkIndex(page, true);
  await waitForPipelineIdle(page);

  // include-metadata OFF → read should fail (the pedagogical path: nothing in the
  // file describes its own layout, so the reader has nothing to work with).
  await setIncludeMetadata(page, false);
  await waitForPipelineIdle(page);
  const offText = await readStatusText(page);
  await shot(page, 'placement-matrix-include-metadata-off');
  h.check(
    'include-metadata OFF → read fails (pedagogical: no self-description in file)',
    /Read failed/.test(offText) && !/File parsed successfully/.test(offText),
    offText.slice(0, 160).replace(/\n/g, ' '),
  );

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
