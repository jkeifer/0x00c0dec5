// Regression scenario: the worker-pipeline surface added by the performance
// plan (Tasks 12-15) — worker compute + stale-view "recomputing" indicator,
// the About modal (commit info + collapsed Performance section), and a
// large-tabular smoke test to confirm the worker pipeline holds up past the
// 32-row starter dataset.
//
// Covers perf plan Task 16, step 1:
//   (a) fresh load boots to idle (pipeline-booting gone, indicator hidden)
//   (b) a sidebar input change flips the indicator on then off
//   (c) About modal: commit string, collapsed-by-default Performance section
//   (d) large-tabular smoke: shape [250000], 3 numeric variables, worker
//       computes it, table renders, hover cross-highlights hex, pipeline
//       strip shows multi-MB byte counts
//
// The array model is NOT exercised at this scale here — GridView is still
// DOM-rendered (Phase 4 of the follow-up plan is the canvas rewrite), so a
// 250K-element array would DOM-explode. That's expected and out of scope for
// this scenario; the large-scale case here is tabular only, where TableView
// is already virtualized (@tanstack/react-virtual).
//
// Run: node tests/ui/scenario-worker-pipeline.mjs   (dev server must be running)

import { launch, shot, createHarness, seedStateAndReload, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-worker-pipeline');

// ── (d) large-tabular seed state: 250,000 rows x 3 numeric variables. ──────
// Plain Node can't import a .ts file (no other scenario does either), so
// this mirrors the shape of src/types/state.ts's DEFAULT_STATE / AppState by
// hand rather than importing it. seedStateAndReload writes directly to the
// localStorage key the app's loadState() reads (persistence.ts's
// STORAGE_KEYS.tabular) and goes through the same migrate ->
// default-merge -> validate pipeline as any real save, so a partial object
// merges fine as long as the fields that matter
// (shape/chunkShape/variables/fieldPipelines) are well-formed; everything
// else (write/metadata/ui/interleaving) is filled in by validateExternalState
// from its own DEFAULT_STATE.
const LARGE_TABULAR_STATE = {
  dataModel: 'tabular',
  shape: [250000],
  chunkShape: [250000],
  interleaving: 'column',
  variables: [
    {
      id: 'a', name: 'a', color: '#e06c75',
      logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
      typeAssignment: { storageDtype: 'float32' },
    },
    {
      id: 'b', name: 'b', color: '#61afef',
      logicalType: { type: 'decimal', min: 900, max: 1100, decimalPlaces: 1, generation: 'sorted' },
      typeAssignment: { storageDtype: 'float32' },
    },
    {
      id: 'c', name: 'c', color: '#98c379',
      logicalType: { type: 'integer', min: 0, max: 100, generation: 'stepped' },
      typeAssignment: { storageDtype: 'uint16' },
    },
  ],
  fieldPipelines: { a: [], b: [], c: [] },
};

async function main() {
  // ── (a) Fresh load boots to idle with default state ──────────────────────
  const { browser, page, issues } = await launch({ fresh: true });

  const bootingGone = (await page.locator('[data-testid="pipeline-booting"]').count()) === 0;
  const indicatorHidden = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="pipeline-computing-indicator"]');
    return el !== null && window.getComputedStyle(el).visibility === 'hidden';
  });
  h.check(
    'fresh load boots to idle: pipeline-booting gone, indicator present but hidden',
    bootingGone && indicatorHidden,
    `bootingGone=${bootingGone} indicatorHidden=${indicatorHidden}`,
  );
  await shot(page, 'worker-pipeline-fresh-idle');

  // ── (b) sidebar input change -> indicator appears then clears. ───────────
  // The default 32-row dataset can compute fast enough in the worker that the
  // visible-then-hidden transition is a timing race not worth chasing (the
  // indicator's own visibility toggle is a pure function of `computing`,
  // already covered by useWorkerPipeline's unit tests). What actually matters
  // here end-to-end is the settled post-condition: the indicator ends up
  // hidden again and the pane actually re-rendered with the new value — i.e.
  // the worker round-trip completed, not just the DOM flag. So we grab the
  // shape input, change it, and assert the settled state rather than trying
  // to catch the indicator mid-flight.
  const shapeInput = page.locator('[data-testid="shape-input"]');
  const beforeCellCount = await page.locator('[data-testid="pane-left"] [data-testid^="table-cell-"]').count();
  await shapeInput.fill('8');
  await shapeInput.blur();
  await waitForPipelineIdle(page);
  const afterIndicatorHidden = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="pipeline-computing-indicator"]');
    return el !== null && window.getComputedStyle(el).visibility === 'hidden';
  });
  const afterCellCount = await page.locator('[data-testid="pane-left"] [data-testid^="table-cell-"]').count();
  h.check(
    'sidebar shape change settles: indicator clears and the pane reflects the new row count',
    afterIndicatorHidden && afterCellCount > 0 && afterCellCount !== beforeCellCount,
    `afterIndicatorHidden=${afterIndicatorHidden} beforeCellCount=${beforeCellCount} afterCellCount=${afterCellCount}`,
  );
  await shot(page, 'worker-pipeline-after-shape-change');

  // ── (c) About modal ────────────────────────────────────────────────────
  await page.locator('[data-testid="about-button"]').click();
  await page.waitForTimeout(300);
  const modal = page.locator('[data-testid="about-modal"]');
  const modalVisible = (await modal.count()) > 0;
  h.check('About modal opens', modalVisible);

  const modalText = await modal.innerText().catch(() => '');
  const hasCommit = /[0-9a-f]{8}/.test(modalText) || /unknown/.test(modalText);
  h.check(
    'About modal shows a non-empty commit string (8-hex short-sha or "unknown" fallback)',
    hasCommit,
    modalText.replace(/\n/g, ' | ').slice(0, 160),
  );

  const perfSectionAbsentInitially = !/Worker status:/.test(modalText);
  h.check(
    'Performance section is collapsed by default (no worker-status text until expanded)',
    perfSectionAbsentInitially,
    modalText.replace(/\n/g, ' | ').slice(0, 160),
  );

  await page.locator('[data-testid="about-performance-toggle"]').click();
  await page.waitForTimeout(200);
  const modalTextExpanded = await modal.innerText().catch(() => '');
  h.check(
    'expanding Performance shows worker status text',
    /Worker status:/.test(modalTextExpanded),
    modalTextExpanded.replace(/\n/g, ' | ').slice(0, 200),
  );
  await shot(page, 'worker-pipeline-about-modal-expanded');

  // Close the modal (click the overlay) before moving on.
  await page.mouse.click(10, 10);
  await page.waitForTimeout(200);

  await browser.close();

  // ── (d) large-tabular smoke, in a fresh context ───────────────────────────
  const { browser: browser2, page: page2, issues: issues2 } = await launch({ fresh: true });
  await seedStateAndReload(page2, {
    '0x00c0dec5-state-tabular': LARGE_TABULAR_STATE,
    '0x00c0dec5-active-model': 'tabular',
  });

  await waitForPipelineIdle(page2, 60000);
  await page2.waitForTimeout(500);

  const rowCellCount = await page2.locator('[data-testid="pane-left"] [data-testid^="table-cell-"]').count();
  h.check(
    'large-tabular (250,000 rows x 3 vars) smoke: table-view renders rows',
    (await page2.locator('[data-testid="table-view"]').count()) > 0 && rowCellCount > 0,
    `rowCellCount=${rowCellCount}`,
  );
  h.check(
    'large-tabular smoke: no page errors during compute/render',
    issues2.pageerror.length === 0,
    issues2.pageerror.slice(0, 3).join(' | '),
  );

  // Hover a table cell in the left pane; expect hex bytes to highlight in the
  // right pane (Write stage, default hex view per D5) — same assertion
  // pattern as scenario-hover-linking.mjs.
  const cell = page2.locator('[data-testid^="table-cell-a-"]').first();
  await cell.hover();
  await page2.waitForTimeout(400);
  const highlightedHexBytes = await page2
    .locator('[data-testid="pane-right"] [data-testid^="hex-byte-"]')
    .evaluateAll((els) => els.filter((e) => (e.style.backgroundColor || '').length > 0).length);
  h.check(
    'large-tabular smoke: hovering a table cell highlights at least one hex byte in the other pane',
    highlightedHexBytes > 0,
    `highlightedHexBytes=${highlightedHexBytes}`,
  );
  await shot(page2, 'worker-pipeline-large-tabular-hover');

  // Pipeline strip shows multi-MB byte counts by this scale (250,000 rows x
  // 3 x float32/uint16-ish storage is several MB by the Values stage alone).
  const stripText = await page2
    .locator('[data-testid^="pipeline-stage-"]')
    .evaluateAll((els) => els.map((e) => e.textContent || '').join(' | '));
  h.check(
    'large-tabular smoke: pipeline strip shows multi-MB byte counts',
    /MB/.test(stripText),
    stripText.slice(0, 300),
  );

  await browser2.close();

  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
