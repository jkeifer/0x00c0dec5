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

import { launch, shot, createHarness, seedStateAndReload, waitForPipelineIdle } from './scenario-helpers.mjs';

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

// Array-model state large enough (200x200 = 40,000 cells) to trigger
// GridCanvas mode (MAX_CELLS = 10,000, GridView.tsx).
function gridCanvasState() {
  return {
    dataModel: 'array',
    shape: [200, 200],
    chunkShape: [50, 50],
    interleaving: 'column',
    variables: [
      {
        id: 'temp', name: 'temp', color: '#e06c75',
        logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
        typeAssignment: { storageDtype: 'float32' },
      },
    ],
    fieldPipelines: { temp: [] },
    chunkPipeline: [],
    // Metadata/Read aren't exercised by this check — leave it off (the app
    // default) rather than old-shape `write.includeMetadata`, which
    // migrateState now drops the WHOLE seed for (metadata redesign Task 1).
    metadata: {
      enabled: false,
      customEntries: [],
      serialization: 'json',
      include: { schema: false, layout: false, codecs: false, chunkIndex: false, descriptive: false, endianness: false },
    },
    write: {
      magicNumber: '00C0DEC5',
      partitioning: 'single',
      metadataPlacement: 'header',
      chunkOrder: 'row-major',
      footerLocator: 'trailer',
    },
    ui: {
      leftPaneStage: 'values',
      rightPaneStage: 'values',
      leftPaneView: 'grid',
      rightPaneView: 'grid',
      showDiff: false,
    },
  };
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

  // ── Byte Shuffle: positional (not value-preserving) tracing ─────────────
  // The bug this pins: byte shuffle transposes bytes within the chunk, but
  // the Encoded layout used to re-base the Linearized region unchanged — so
  // hovering an element highlighted the byte range it occupied BEFORE the
  // shuffle, and the Encoded pane displayed the pre-codec values. Now a
  // shuffled chunk's slots are positional: a value hover finds no matching
  // bytes and degrades to the chunk wash, exactly like an entropy codec.
  await page.mouse.move(10, 10);
  await page.locator('[data-testid="sidebar-section-codecs"] select').first().selectOption('byte-shuffle');
  await page.waitForTimeout(600);
  await setPaneStage(page, 'right', 'encoded');

  const cellAfterShuffle = page.locator('[data-testid="pane-left"] [data-testid^="table-cell-temperature-"]').first();
  await cellAfterShuffle.hover();
  await page.waitForTimeout(400);
  await shot(page, 'hover-linking-byte-shuffle-positional');

  const shuffleHighlights = await highlightCounts(page, '[data-testid="pane-right"]');
  h.check(
    'after byte shuffle, hovering a table cell no longer strong-highlights a (now wrong) byte range in the Encoded pane',
    shuffleHighlights.valueLevel === 0 && shuffleHighlights.chunkLevel > 1,
    `valueLevel=${shuffleHighlights.valueLevel} chunkLevel=${shuffleHighlights.chunkLevel}`,
  );

  // Hovering a shuffled byte highlights exactly its own slot (one dtype's
  // worth of bytes), and the hover bar says the value is positional only.
  await page.mouse.move(10, 10);
  const shuffledByte = page.locator('[data-testid="pane-right"] [data-testid^="hex-byte-"]').nth(9);
  await shuffledByte.hover();
  await page.waitForTimeout(400);
  await shot(page, 'hover-linking-byte-shuffle-slot');

  const slotHighlights = await highlightCounts(page, '[data-testid="pane-right"]');
  h.check(
    'hovering a shuffled byte strong-highlights only its own positional slot',
    slotHighlights.valueLevel > 0 && slotHighlights.valueLevel <= 8,
    `valueLevel=${slotHighlights.valueLevel} chunkLevel=${slotHighlights.chunkLevel}`,
  );
  h.check(
    'hover bar flags a shuffled slot as byte-position-only, not this element\'s data',
    await page.locator('[data-testid="hover-bar-positional"]').count() > 0,
    (await page.locator('[data-testid="hover-bar"]').innerText()).replace(/\n/g, ' | ').slice(0, 220),
  );

  // The Encoded pane's Flat view must show what the shuffled bytes decode to,
  // not the pre-codec values the Linearized pane shows.
  await page.mouse.move(10, 10);
  await setPaneViewMode(page, 'right', 'Flat');
  await page.waitForTimeout(300);
  const encodedFlat = await page.locator('[data-testid="pane-right"] [data-testid="flat-view"]').innerText();
  await shot(page, 'hover-linking-byte-shuffle-flat-encoded');
  await setPaneStage(page, 'right', 'linearized');
  await page.waitForTimeout(300);
  const linearizedFlat = await page.locator('[data-testid="pane-right"] [data-testid="flat-view"]').innerText();
  await shot(page, 'hover-linking-byte-shuffle-flat');
  h.check(
    'Encoded flat view shows the shuffled bytes\' values, not the Linearized stage\'s values',
    encodedFlat.length > 0 && encodedFlat !== linearizedFlat,
    `encoded[0:80]=${encodedFlat.replace(/\n/g, ' | ').slice(0, 80)}`,
  );

  // Drop the shuffle step so the RLE block below starts from a clean pipeline.
  await page.locator('[data-testid="sidebar-section-codecs"] button[aria-label="Remove Byte Shuffle"]').click();
  await page.waitForTimeout(500);
  await setPaneViewMode(page, 'right', 'Hex');

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

  // ── Fix pin: a Values-stage table-cell hover must produce a visible ──
  // value-level (strong) highlight on the hovered value's bytes in a Typed
  // hex pane — the original complaint was that only the chunk wash was
  // visible, not the specific value. The wash itself is intentional (it
  // shows chunk membership); the strong accent-tinted highlight on top is
  // the fix. Left pane is already Typed/Hex from the block above.
  await page.mouse.move(10, 10);
  await setPaneStage(page, 'right', 'values');
  await setPaneViewMode(page, 'right', 'Table');
  const valuesCell = page.locator('[data-testid="pane-right"] [data-testid^="table-cell-temperature-"]').first();
  await valuesCell.hover();
  await page.waitForTimeout(400);
  await shot(page, 'hover-linking-values-strong-highlight-typed-hex');

  const typedHexHighlights = await highlightCounts(page, '[data-testid="pane-left"]');
  h.check(
    'hovering a Values-stage table cell strong-highlights the matching bytes in a Typed-stage hex pane',
    typedHexHighlights.valueLevel > 0,
    `valueLevel=${typedHexHighlights.valueLevel} chunkLevel=${typedHexHighlights.chunkLevel}`,
  );

  await browser.close();

  // ── GridCanvas overlay alignment + hover symbology (Task 1) ─────────────
  // 200x200 = 40,000 cells, over MAX_CELLS (10,000), so GridView renders the
  // canvas path. Seed both panes into grid view and hover a cell far from
  // the canvas origin (row 150, col 150) so any padding-based scale drift
  // in the overlay math is large enough to detect reliably.
  const { browser: browser2, page: page2 } = await launch();
  await seedStateAndReload(page2, {
    '0x00c0dec5-state-array': gridCanvasState(),
    '0x00c0dec5-active-model': 'array',
  });
  await waitForPipelineIdle(page2, 90_000);
  await page2.waitForTimeout(500);

  const canvas = page2.locator('[data-testid="pane-left"] [data-testid="grid-canvas"]');
  const canvasBox = await canvas.boundingBox();
  h.check('grid-canvas has a bounding box', !!canvasBox, JSON.stringify(canvasBox));

  if (canvasBox) {
    const cellPx = canvasBox.width / 200; // cols = 200
    const targetX = canvasBox.x + 150.5 * cellPx; // center of col 150
    const targetY = canvasBox.y + 150.5 * cellPx; // center of row 150
    await page2.mouse.move(targetX, targetY);
    await page2.waitForTimeout(400);
    await shot(page2, 'grid-canvas-hover-dark-region');

    const hoverCell = page2.locator('[data-testid="pane-left"] [data-testid="grid-hover-cell"]');
    const hoverCellBox = await hoverCell.boundingBox();
    let centerOffset = null;
    if (hoverCellBox) {
      const cx = hoverCellBox.x + hoverCellBox.width / 2;
      const cy = hoverCellBox.y + hoverCellBox.height / 2;
      centerOffset = Math.hypot(cx - targetX, cy - targetY);
    }
    h.check(
      'grid-hover-cell overlay is centered within 1 cell-width of the mouse position',
      hoverCellBox !== null && centerOffset !== null && centerOffset < cellPx,
      `centerOffset=${centerOffset === null ? 'n/a' : centerOffset.toFixed(2)}, cellPx=${cellPx.toFixed(2)}`,
    );

    const hoverCellBg = hoverCellBox ? await hoverCell.evaluate((el) => getComputedStyle(el).backgroundColor) : null;
    h.check(
      'grid-hover-cell overlay has a non-transparent background-color (filled, not outline-only)',
      hoverCellBg !== null && hoverCellBg !== 'rgba(0, 0, 0, 0)' && hoverCellBg !== 'transparent',
      `backgroundColor=${hoverCellBg}`,
    );

    const hoverChunk = page2.locator('[data-testid="pane-left"] [data-testid="grid-hover-chunk"]');
    const hoverChunkCount = await hoverChunk.count();
    h.check('grid-hover-chunk overlay exists while hovering', hoverChunkCount === 1, `count=${hoverChunkCount}`);
    if (hoverChunkCount === 1) {
      const hoverChunkBg = await hoverChunk.evaluate((el) => getComputedStyle(el).backgroundColor);
      h.check(
        'grid-hover-chunk overlay has a non-transparent background-color (filled, not outline-only)',
        hoverChunkBg !== 'rgba(0, 0, 0, 0)' && hoverChunkBg !== 'transparent',
        `backgroundColor=${hoverChunkBg}`,
      );
    }
  }

  await browser2.close();

  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
