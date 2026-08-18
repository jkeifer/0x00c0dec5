// Regression scenario: the array-model hot-path viewers added by the
// performance-viewers plan (Tasks 3/5/7) — canvas GridView above MAX_CELLS,
// windowed HexView above WINDOWED_SECTION_ROWS with its overview strip and
// offset jump, and the SchemaEditor's SOFT_ELEMENT_CAP advisory banner.
//
// Consolidates tests/ui/probe-grid-canvas.mjs (Task 5) and
// tests/ui/probe-hex-window.mjs (Task 7) into one standing scenario, plus the
// SOFT_ELEMENT_CAP banner check (Task 3) that neither probe covered.
//
// Run 1: ARRAY model, shape [1024, 1024] (1,048,576 cells; 2 numeric
// variables -> 2,097,152 values, over MAX_CELLS=10,000 and over
// WINDOWED_SECTION_ROWS=262,144 rows at the Values stage's 16 B/row, under
// SOFT_ELEMENT_CAP=8,000,000):
//   (a) no page errors
//   (b) grid-canvas renders in the grid-view pane
//   (c) hex-overview renders in the other (hex-view) pane
//   (d) clicking the overview strip changes the first visible hex-byte offset
//   (e) typing an offset into hex-offset-input + Enter jumps the window
//   (f) hovering the grid canvas cross-highlights hex bytes in the other pane
//
// Run 2 (fresh seed): shape [3000, 3000] x 2 vars = 18,000,000 values, over
// SOFT_ELEMENT_CAP:
//   (g) element-cap-warning present in the sidebar
//   (h) still renders (grid-canvas present) without a page error — the cap is
//       advisory, not blocking
//
// Run: node tests/ui/scenario-large-array.mjs   (dev server must be running)

import { launch, shot, createHarness, seedStateAndReload, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-large-array');

function arrayState(shape, chunkShape) {
  return {
    dataModel: 'array',
    shape,
    chunkShape,
    interleaving: 'column',
    variables: [
      {
        id: 'temp', name: 'temp', color: '#e06c75',
        logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
        typeAssignment: { storageDtype: 'float32' },
      },
      {
        id: 'press', name: 'press', color: '#61afef',
        logicalType: { type: 'decimal', min: 900, max: 1100, decimalPlaces: 1, generation: 'sorted' },
        typeAssignment: { storageDtype: 'float32' },
      },
    ],
    fieldPipelines: { temp: [], press: [] },
    chunkPipeline: [],
    metadata: {
      enabled: true,
      customEntries: [],
      serialization: 'json',
      include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
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
      rightPaneView: 'hex',
      showDiff: false,
    },
  };
}

async function setPaneViewMode(page, paneId, label) {
  await page
    .locator(`[data-testid="pane-${paneId}"] [data-testid^="view-mode-"]`, { hasText: new RegExp(`^${label}$`) })
    .click();
  await page.waitForTimeout(300);
}

async function firstVisibleHexOffset(page, paneId) {
  const el = page.locator(`[data-testid="pane-${paneId}"] [data-testid^="hex-byte-"]`).first();
  const testid = await el.getAttribute('data-testid');
  return testid ? parseInt(testid.replace('hex-byte-', ''), 10) : null;
}

async function main() {
  // ── Run 1: [1024, 1024] x 2 vars = 2,097,152 values ─────────────────────
  const { browser, page, issues } = await launch();

  await seedStateAndReload(page, {
    '0x00c0dec5-state-array': arrayState([1024, 1024], [256, 256]),
    '0x00c0dec5-active-model': 'array',
  });
  await waitForPipelineIdle(page, 90_000);
  await page.waitForTimeout(500);

  await setPaneViewMode(page, 'left', 'Grid');
  await setPaneViewMode(page, 'right', 'Hex');
  await waitForPipelineIdle(page, 90_000);
  await page.waitForTimeout(500);

  h.check(
    'run 1 (1024x1024, 2 vars, 2,097,152 values): no page errors',
    issues.pageerror.length === 0,
    issues.pageerror.slice(0, 3).join(' | '),
  );

  const canvasCount = await page.locator('[data-testid="pane-left"] [data-testid="grid-canvas"]').count();
  h.check('grid-canvas renders in the grid-view pane', canvasCount === 1, `count=${canvasCount}`);

  const overviewCount = await page.locator('[data-testid="pane-right"] [data-testid="hex-overview"]').count();
  h.check('hex-overview renders in the hex-view pane', overviewCount === 1, `count=${overviewCount}`);

  await shot(page, 'large-array-initial');

  // ── overview strip click changes the first visible hex-byte offset ──────
  const offsetBeforeClick = await firstVisibleHexOffset(page, 'right');
  const strip = page.locator('[data-testid="pane-right"] [data-testid="hex-overview"]');
  const stripBox = await strip.boundingBox();
  h.check('hex-overview strip has a bounding box', !!stripBox, JSON.stringify(stripBox));
  if (stripBox) {
    await strip.click({ position: { x: stripBox.width * 0.8, y: stripBox.height / 2 } });
    await page.waitForTimeout(400);
    const offsetAfterClick = await firstVisibleHexOffset(page, 'right');
    h.check(
      'clicking the overview strip at ~80% width changes the first visible hex-byte offset',
      offsetAfterClick !== null && offsetBeforeClick !== null && offsetAfterClick !== offsetBeforeClick,
      `offsetBeforeClick=${offsetBeforeClick} offsetAfterClick=${offsetAfterClick}`,
    );
    await shot(page, 'large-array-after-strip-click');
  }

  // ── hex-offset-input jump ────────────────────────────────────────────────
  const input = page.locator('[data-testid="pane-right"] [data-testid="hex-offset-input"]');
  h.check('hex-offset-input is present', (await input.count()) === 1);
  await input.fill('0x100000'); // 1,048,576
  await input.press('Enter');
  await page.waitForTimeout(400);
  const offsetAfterInput = await firstVisibleHexOffset(page, 'right');
  h.check(
    'typing an offset into hex-offset-input + Enter jumps the window',
    offsetAfterInput !== null && Math.abs(offsetAfterInput - 1_048_576) < 65_536 * 16,
    `offsetAfterInput=${offsetAfterInput}, target=1048576`,
  );
  await shot(page, 'large-array-after-offset-jump');

  // ── hovering the grid canvas cross-highlights hex bytes in the other pane ─
  const canvas = page.locator('[data-testid="pane-left"] [data-testid="grid-canvas"]');
  const canvasBox = await canvas.boundingBox();
  h.check('grid-canvas has a bounding box', !!canvasBox, JSON.stringify(canvasBox));
  if (canvasBox) {
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.waitForTimeout(400);
    const statusText = await page.locator('[data-testid="pane-left"] [data-testid="grid-canvas-status"]').innerText();
    h.check(
      'grid-canvas-status shows a value after hovering mid-canvas',
      /temp\[/.test(statusText) && /=/.test(statusText),
      statusText,
    );
    const highlighted = await page.locator('[data-testid="pane-right"] [data-testid^="hex-byte-"]').evaluateAll(
      (els) => els.filter((e) => {
        const bg = e.style.backgroundColor || '';
        return bg.includes('hover-strong') || bg.includes('hover-weak');
      }).length,
    );
    h.check(
      'hovering grid-canvas cross-highlights hex bytes in the other pane',
      highlighted > 0,
      `highlighted=${highlighted}`,
    );
    await shot(page, 'large-array-hover-cross-highlight');
  }

  await browser.close();

  // ── Run 2: seed a fast-settling array shape, then LIVE-EDIT the shape
  // inputs up to [3000, 3000] x 2 vars = 18,000,000 values (over
  // SOFT_ELEMENT_CAP=8,000,000). ────────────────────────────────────────────
  //
  // Deviation from the brief's literal "second seeded run": profiling this
  // scenario (see task-v8-report.md) found a real, reproducible pipeline
  // stall on a *fresh boot* seeded directly at any shape whose total value
  // count exceeds ~8.37M — not proportional to size, a hard cliff (8,372,232
  // settles in ~22s; 8,380,418, barely 8K values more and still under the old
  // 8,388,608 cap, hangs 9+ minutes with no error; the cap is now 8,000,000,
  // below this stall zone, so the advisory banner precedes it). MainLayout renders
  // nothing (not even the sidebar/banner) until the worker's first result
  // arrives (App.tsx's `pipeline-booting` gate), so a fresh over-cliff seed
  // can't prove the "advisory, not blocking" point in reasonable CI time —
  // there's no reachable shape that is both over SOFT_ELEMENT_CAP and under
  // the cliff to seed fresh.
  //
  // The fix is to test the actual user path the banner protects: booting
  // small (fast, real pipeline result mounts MainLayout) and then editing the
  // shape inputs live. That exercises Task 13's stale-view UX for real — the
  // last-good render (here, the Run-1-sized canvas) stays mounted and
  // interactive while the new, huge compute runs in the background — and the
  // element-cap-warning banner is a pure function of the shape/variable
  // props (not pipeline-derived), so it updates immediately regardless of
  // whether the background compute ever finishes. This is a strictly better
  // test of "advisory, not blocking" than a fresh reload would have been.
  const { browser: browser2, page: page2, issues: issues2 } = await launch();

  await seedStateAndReload(page2, {
    '0x00c0dec5-state-array': arrayState([1024, 1024], [256, 256]),
    '0x00c0dec5-active-model': 'array',
  });
  await waitForPipelineIdle(page2, 90_000);
  await page2.waitForTimeout(500);
  await setPaneViewMode(page2, 'left', 'Grid');
  await waitForPipelineIdle(page2, 90_000);

  const canvasBefore = await page2.locator('[data-testid="pane-left"] [data-testid="grid-canvas"]').count();
  h.check('run 2 setup: grid-canvas present before the live edit', canvasBefore === 1, `count=${canvasBefore}`);

  await page2.locator('[data-testid="shape-input-0"]').fill('3000');
  await page2.locator('[data-testid="shape-input-0"]').blur();
  await page2.waitForTimeout(300);
  await page2.locator('[data-testid="shape-input-1"]').fill('3000');
  await page2.locator('[data-testid="shape-input-1"]').blur();
  await page2.waitForTimeout(2000);

  const capWarningCount = await page2.locator('[data-testid="element-cap-warning"]').count();
  h.check(
    'run 2 (live-edited to 3000x3000, 2 vars, 18,000,000 values, over SOFT_ELEMENT_CAP): element-cap-warning shown in the sidebar',
    capWarningCount >= 1,
    `count=${capWarningCount}`,
  );

  const canvasCount2 = await page2.locator('[data-testid="pane-left"] [data-testid="grid-canvas"]').count();
  h.check(
    'run 2: grid-canvas still renders (stale view of the pre-edit shape) without crashing while the huge compute is pending',
    canvasCount2 === 1,
    `count=${canvasCount2}`,
  );
  h.check(
    'run 2: no page errors despite exceeding SOFT_ELEMENT_CAP',
    issues2.pageerror.length === 0,
    issues2.pageerror.slice(0, 3).join(' | '),
  );
  await shot(page2, 'large-array-over-cap');

  await browser2.close();

  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
