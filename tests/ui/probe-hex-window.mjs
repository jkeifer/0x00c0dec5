// Throwaway probe for Task 7 (viewers plan): HexView windowed mode above
// WINDOWED_SECTION_ROWS (262,144 rows). Seeds a TABULAR state, shape
// [600000], 3 float64 vars (values stage = 600000 * 3 * 8 = 14.4MB = 900,000
// rows at 16 B/row > threshold, so left pane's Values/Hex view is windowed).
//
// Asserts: hex-overview (FileMapStrip) present; clicking the strip near 80%
// width jumps the window (first visible hex-byte offset changes to a far
// offset); typing an offset into hex-offset-input + Enter jumps the window;
// hovering a table cell in the OTHER pane (right, Values/Table) lands a
// visible cross-pane highlight in the (now far-scrolled) left Hex window.
//
// Not a standing scenario (tests/ui/scenario-*.mjs) — see task-7-brief.md.
//
// Run: node tests/ui/probe-hex-window.mjs   (dev server must be running)

import { launch, shot, createHarness, seedStateAndReload, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('probe-hex-window');

const tabularState = {
  dataModel: 'tabular',
  shape: [600000],
  chunkShape: [100000],
  interleaving: 'row',
  variables: [
    {
      id: 'a', name: 'a', color: '#e06c75',
      logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
      typeAssignment: { storageDtype: 'float64' },
    },
    {
      id: 'b', name: 'b', color: '#61afef',
      logicalType: { type: 'decimal', min: 900, max: 1100, decimalPlaces: 1, generation: 'sorted' },
      typeAssignment: { storageDtype: 'float64' },
    },
    {
      id: 'c', name: 'c', color: '#98c379',
      logicalType: { type: 'decimal', min: 0, max: 1, decimalPlaces: 2, generation: 'random' },
      typeAssignment: { storageDtype: 'float64' },
    },
  ],
  fieldPipelines: { a: [], b: [], c: [] },
  chunkPipeline: [],
  metadata: { customEntries: [], serialization: 'json', includeChunkIndex: true },
  write: {
    includeMetadata: false,
    magicNumber: '00C0DEC5',
    partitioning: 'single',
    metadataPlacement: 'header',
    chunkOrder: 'row-major',
    footerLocator: 'trailer',
  },
  ui: {
    leftPaneStage: 'values',
    rightPaneStage: 'values',
    leftPaneView: 'hex',
    rightPaneView: 'table',
    showDiff: false,
  },
};

async function setPaneViewMode(page, paneId, label) {
  await page
    .locator(`[data-testid="pane-${paneId}"] [data-testid^="view-mode-"]`, { hasText: new RegExp(`^${label}$`) })
    .click();
  await page.waitForTimeout(300);
}

async function firstVisibleHexOffset(page) {
  const el = await page.locator('[data-testid="pane-left"] [data-testid^="hex-byte-"]').first();
  const testid = await el.getAttribute('data-testid');
  return testid ? parseInt(testid.replace('hex-byte-', ''), 10) : null;
}

async function main() {
  const { browser, page } = await launch();

  await seedStateAndReload(page, {
    '0x00c0dec5-state-tabular': tabularState,
    '0x00c0dec5-active-model': 'tabular',
  });
  await waitForPipelineIdle(page);
  await page.waitForTimeout(500);

  await setPaneViewMode(page, 'left', 'Hex');
  await setPaneViewMode(page, 'right', 'Table');
  await waitForPipelineIdle(page);
  await page.waitForTimeout(500);

  const overviewCount = await page.locator('[data-testid="pane-left"] [data-testid="hex-overview"]').count();
  h.check('hex-overview (FileMapStrip) present for a 900,000-row (>262,144) section', overviewCount === 1, `count=${overviewCount}`);

  const offsetBefore = await firstVisibleHexOffset(page);
  h.check('initial window starts near byte 0', offsetBefore !== null && offsetBefore < 1000, `offsetBefore=${offsetBefore}`);

  await shot(page, 'probe-hex-window-initial');

  // Click the strip at ~80% width -> window should jump to a far offset.
  const strip = page.locator('[data-testid="pane-left"] [data-testid="hex-overview"]');
  const box = await strip.boundingBox();
  h.check('strip has a bounding box', !!box, JSON.stringify(box));
  if (box) {
    await strip.click({ position: { x: box.width * 0.8, y: box.height / 2 } });
    await page.waitForTimeout(400);
    const offsetAfterClick = await firstVisibleHexOffset(page);
    h.check(
      'clicking the strip at ~80% width jumps the window to a far offset',
      offsetAfterClick !== null && offsetAfterClick > 5_000_000,
      `offsetAfterClick=${offsetAfterClick}`,
    );
    await shot(page, 'probe-hex-window-after-strip-click');
  }

  // Type an offset into hex-offset-input + Enter -> window jumps accordingly.
  const input = page.locator('[data-testid="pane-left"] [data-testid="hex-offset-input"]');
  await input.fill('0x100000'); // 1,048,576
  await input.press('Enter');
  await page.waitForTimeout(400);
  const offsetAfterInput = await firstVisibleHexOffset(page);
  h.check(
    'typing an offset into hex-offset-input + Enter jumps the window',
    offsetAfterInput !== null && Math.abs(offsetAfterInput - 1_048_576) < 65_536 * 16,
    `offsetAfterInput=${offsetAfterInput}, target=1048576`,
  );
  await shot(page, 'probe-hex-window-after-input-jump');

  // Invalid input is ignored silently (no crash, window doesn't move).
  await input.fill('not-hex');
  await input.press('Enter');
  await page.waitForTimeout(300);
  const offsetAfterInvalid = await firstVisibleHexOffset(page);
  h.check(
    'invalid offset input is ignored (window unchanged, no crash)',
    offsetAfterInvalid === offsetAfterInput,
    `offsetAfterInvalid=${offsetAfterInvalid}`,
  );

  // Cross-pane: scroll the right pane's table far down (row ~500,000, well
  // outside the hex window's current position near byte ~524288/row ~32768)
  // and hover a cell there -> the left Hex window must jump to and land
  // visibly on the corresponding bytes (proves scrollToRow crosses windows,
  // not just a coincidental landing at row 0).
  const FAR_ROW = 500_000;
  await page.locator('[data-testid="pane-right"] [data-testid="table-view"]').evaluate((el, row) => {
    el.scrollTop = row * 24; // TableView ROW_HEIGHT = 24
  }, FAR_ROW);
  await page.waitForTimeout(300);

  const cell = page.locator('[data-testid="pane-right"] [data-testid^="table-cell-a-"]').first();
  await cell.hover();
  await page.waitForTimeout(500);

  const highlighted = await page.locator('[data-testid="pane-left"] [data-testid^="hex-byte-"]').evaluateAll(
    (els) => els.filter((e) => {
      const bg = e.style.backgroundColor || '';
      return bg.includes('hover-strong') || bg.includes('hover-weak');
    }).length,
  );
  const offsetAfterHover = await firstVisibleHexOffset(page);
  // The hex window was parked at byte 524,288 after the offset-input jump.
  // Hovering a table row far from the start should move it well away from
  // that position (exact byte layout depends on chunking/interleaving, so
  // assert "moved substantially", not an exact target) while still lighting
  // up highlights — together that demonstrates scrollToRow crossing windows.
  h.check(
    'hovering a far table cell in the other pane lands a visible cross-pane highlight after jumping windows',
    highlighted > 0 && offsetAfterHover !== null && Math.abs(offsetAfterHover - 524_288) > 1_000_000,
    `highlighted=${highlighted}, windowOffsetNow=${offsetAfterHover}`,
  );
  await shot(page, 'probe-hex-window-cross-pane-hover');

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
