// Regression scenario: cross-pane hover linking.
//
// Stage identity reference (fixed order, D5 — see src/types/pipeline.ts's
// STAGE_ORDER): 'values', 'typed', 'linearized', 'encoded', 'metadata',
// 'write', 'read'. Phase 3.8 changed the pane dropdown's <option> values from
// numeric indices to these names, so setPaneStage below selects by name.
//
// UI-2 (docs/remediation-plan.md Part 1, "UI components") FIXED by Phase 4 task 4.2:
// hovering a hex byte in the Values/Typed/Read stages' HexView now cross-highlights a
// post-entropy pane (e.g. Encoded after RLE) because HexView/FlatView fall back to
// traceChunkMap (traceId -> chunkId) when a trace's own chunkId is empty, the same
// fallback TableView already used. This scenario asserts the cross-highlight actually
// happens (chunk-level highlighting in the post-RLE Encoded pane).
//
// Run: node tests/ui/scenario-hover-linking.mjs   (dev server must be running)

import { launch, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-hover-linking');

// Hover highlights are theme-aware CSS vars since plan Phase 4 (was
// hardcoded white-alpha rgba literals): value-level = var(--hover-strong),
// chunk-level = var(--hover-weak). Inline style attributes preserve the var()
// text, so match on the var names.
async function highlightCounts(page, paneSelector) {
  return page.locator(`${paneSelector} [data-testid^="hex-byte-"]`).evaluateAll((els) => ({
    valueLevel: els.filter((e) => (e.style.backgroundColor || '').includes('hover-strong')).length,
    chunkLevel: els.filter((e) => (e.style.backgroundColor || '').includes('hover-weak')).length,
  }));
}

async function tableHighlightCount(page, paneSelector) {
  return page.locator(`${paneSelector} [data-testid^="table-cell-"]`).evaluateAll(
    (els) => els.filter((e) => {
      const bg = e.style.backgroundColor || '';
      return bg.includes('hover-strong') || bg.includes('hover-weak');
    }).length,
  );
}

async function setPaneStage(page, paneId, stageName) {
  await page.locator(`[data-testid="pane-dropdown-${paneId}"]`).selectOption(stageName);
  await page.waitForTimeout(300);
}

async function setPaneViewMode(page, paneId, label) {
  await page
    .locator(`[data-testid="pane-${paneId}"] [data-testid^="view-mode-"]`, { hasText: new RegExp(`^${label}$`) })
    .click();
  await page.waitForTimeout(300);
}

async function main() {
  const { browser, page } = await launch();

  // ── Left pane stays Values/Table (default). Right pane -> Write stage / Hex. ──
  await setPaneStage(page, 'right', 'write');
  await setPaneViewMode(page, 'right', 'Hex');

  // Forward: hover a table cell in the left pane, expect hex bytes to highlight
  // on the right and the hover bar to populate.
  const cell = page.locator('[data-testid^="table-cell-temperature-"]').first();
  await cell.hover();
  await page.waitForTimeout(400);
  await shot(page, 'hover-linking-table-to-hex');

  const barTextForward = await page.locator('[data-testid="hover-bar"]').innerText();
  const forwardHighlights = await highlightCounts(page, '[data-testid="pane-right"]');
  h.check(
    'hover-bar populates when hovering a Values-stage table cell',
    barTextForward.length > 0 && !/Hover a value to trace it/.test(barTextForward),
    barTextForward.replace(/\n/g, ' | ').slice(0, 160),
  );
  h.check(
    'hovering left table cell highlights hex bytes in right pane (Write stage)',
    forwardHighlights.valueLevel > 0,
    `valueLevel=${forwardHighlights.valueLevel} chunkLevel=${forwardHighlights.chunkLevel}`,
  );

  // Reverse: hover a hex byte on the right, expect left-pane table cell(s) to highlight.
  await page.mouse.move(10, 10);
  await page.waitForTimeout(200);
  const hexByte = page.locator('[data-testid="pane-right"] [data-testid^="hex-byte-"]').nth(20);
  await hexByte.hover();
  await page.waitForTimeout(400);
  await shot(page, 'hover-linking-hex-to-table');

  const barTextReverse = await page.locator('[data-testid="hover-bar"]').innerText();
  const leftHighlighted = await tableHighlightCount(page, '[data-testid="pane-left"]');
  h.check(
    'hover-bar populates when hovering a Write-stage hex byte',
    barTextReverse.length > 0 && !/Hover a value to trace it/.test(barTextReverse),
    barTextReverse.replace(/\n/g, ' | ').slice(0, 160),
  );
  h.check(
    'hovering right hex byte highlights the corresponding left table cell',
    leftHighlighted > 0,
    `leftHighlighted=${leftHighlighted}`,
  );

  // ── Add RLE to temperature (column mode default codec pipeline), then hover ──
  // an Encoded-stage byte and confirm chunk-level (multi-cell) highlighting.
  await page.mouse.move(10, 10);
  await page.locator('[data-testid="sidebar-section-codecs"] select').first().selectOption('rle');
  await page.waitForTimeout(500);
  await setPaneStage(page, 'right', 'encoded');

  const cellAfterRle = page.locator('[data-testid="pane-left"] [data-testid^="table-cell-temperature-"]').first();
  await cellAfterRle.hover();
  await page.waitForTimeout(400);
  await shot(page, 'hover-linking-rle-chunk-level');

  const rleHighlights = await highlightCounts(page, '[data-testid="pane-right"]');
  h.check(
    'after adding RLE, hovering a table cell shows chunk-level (multi-byte) highlighting in Encoded pane, not value-level',
    rleHighlights.chunkLevel > 1 && rleHighlights.valueLevel === 0,
    `valueLevel=${rleHighlights.valueLevel} chunkLevel=${rleHighlights.chunkLevel}`,
  );

  // ── UI-2 fixed: hover a hex byte in the Typed stage's HexView; expect a ──
  // cross-highlight in the (post-RLE) Encoded pane, since Typed-stage traces'
  // empty chunkId now falls back to traceChunkMap's traceId -> chunkId entry.
  await page.mouse.move(10, 10);
  await setPaneStage(page, 'left', 'typed');
  await setPaneViewMode(page, 'left', 'Hex');
  await setPaneStage(page, 'right', 'encoded'); // post-RLE

  const typedHexByte = page.locator('[data-testid="pane-left"] [data-testid^="hex-byte-"]').nth(2);
  await typedHexByte.hover();
  await page.waitForTimeout(400);
  await shot(page, 'hover-linking-typed-hex-to-encoded');

  const encodedHighlightsFromTypedHex = await highlightCounts(page, '[data-testid="pane-right"]');
  const crossHighlightWorked = encodedHighlightsFromTypedHex.valueLevel > 0 || encodedHighlightsFromTypedHex.chunkLevel > 0;
  h.check(
    'hovering a Typed-stage hex byte cross-highlights the (post-RLE) Encoded pane',
    crossHighlightWorked,
    `valueLevel=${encodedHighlightsFromTypedHex.valueLevel} chunkLevel=${encodedHighlightsFromTypedHex.chunkLevel}`,
  );

  // ── HoverBar shows the full stage chain (byte counts) for this hover too. ──
  const barTextTypedHex = await page.locator('[data-testid="hover-bar"]').innerText();
  h.check(
    'hover-bar shows the Encoded stage in the chain when hovering a Typed-stage hex byte',
    /Encoded:/.test(barTextTypedHex),
    barTextTypedHex.replace(/\n/g, ' | ').slice(0, 200),
  );

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
