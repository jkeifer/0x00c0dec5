// Spot-check for task 4.5 (remediation-plan.md, fixes UI-5/UI-14) + the
// extension-read-step.md Diff View spec: per-variable diff summary stats in
// TableView/GridView when viewing the Read stage with diff mode on.
//
// Scenario: enable a lossy type assignment (scale/offset on an int storage
// dtype for a decimal/continuous variable), enable Include metadata (so Read
// succeeds), select the Read stage + diff mode in both Table and Grid view,
// and verify the summary numbers render without NaN and hover stays smooth
// (no console errors, no exceptions).
//
// Run: node tests/ui/scenario-diff-summary.mjs   (dev server must be running)

import { launch, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-diff-summary');

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
  const { browser, page, issues } = await launch();

  // ── 1. Force a lossy config: give `pressure` (decimal/continuous default)
  //      an int8 storage dtype via Type Assignment so scale/offset applies
  //      and precision is lost on the float64 -> int8 -> float64 round trip.
  await page.locator('[data-testid="sidebar-section-typing"]').scrollIntoViewIfNeeded();
  const typingSection = page.locator('[data-testid="sidebar-section-typing"]');
  const dtypeSelects = typingSection.locator('select');
  const selectCount = await dtypeSelects.count();
  h.check('type assignment section has per-variable dtype selects', selectCount > 0, `count=${selectCount}`);
  // First variable's storage dtype select -> int8 (forces scale/offset, lossy)
  await dtypeSelects.first().selectOption('int8');
  await page.waitForTimeout(300);

  // ── 2. Enable "Include metadata" so Read succeeds. ──
  const writeSection = page.locator('[data-testid="sidebar-section-write"]');
  await writeSection.scrollIntoViewIfNeeded();
  const includeMetadataYes = page.locator('[data-testid="include-metadata-toggle"] button', { hasText: /^Yes$/ });
  await includeMetadataYes.click();
  await page.waitForTimeout(400);

  // ── 3. Enable diff mode in the Read section. ──
  const readSection = page.locator('[data-testid="sidebar-section-read"]');
  await readSection.scrollIntoViewIfNeeded();
  const readStatus = page.locator('[data-testid="read-status"]');
  const readOk = await readStatus.locator('text=File parsed successfully').count();
  h.check('read succeeded after enabling Include metadata', readOk > 0);

  const diffYes = readStatus.locator('button, [role="radio"]', { hasText: /^Yes$/ }).first();
  await diffYes.click();
  await page.waitForTimeout(300);

  // ── 4. Right pane -> Read stage, Table view. ──
  await setPaneStage(page, 'right', 'read');
  await setPaneViewMode(page, 'right', 'Table');
  await page.waitForTimeout(400);
  await shot(page, 'diff-summary-table');

  const tableSummary = page.locator('[data-testid="pane-right"] [data-testid^="table-diff-summary-"]').first();
  const tableSummaryText = await tableSummary.textContent().catch(() => null);
  h.check(
    'table diff summary renders with no NaN',
    !!tableSummaryText && !tableSummaryText.includes('NaN'),
    `text="${tableSummaryText}"`,
  );

  // Hover a cell to make sure interactions stay smooth (no thrown errors).
  const cell = page.locator('[data-testid^="table-cell-"]').first();
  await cell.hover();
  await page.waitForTimeout(300);

  // ── 5. Right pane -> Grid view. ──
  await setPaneViewMode(page, 'right', 'Grid');
  await page.waitForTimeout(400);
  await shot(page, 'diff-summary-grid');

  const gridSummary = page.locator('[data-testid="pane-right"] [data-testid^="grid-diff-summary-"]').first();
  const gridSummaryText = await gridSummary.textContent().catch(() => null);
  h.check(
    'grid diff summary renders with no NaN',
    !!gridSummaryText && !gridSummaryText.includes('NaN'),
    `text="${gridSummaryText}"`,
  );

  // Hover a grid cell repeatedly to spot-check smoothness / no NaN colors.
  const gridCells = page.locator('[data-testid="pane-right"] [data-cell-idx]');
  const cellCount = await gridCells.count();
  h.check('grid renders cells', cellCount > 0, `count=${cellCount}`);
  if (cellCount > 0) {
    for (let i = 0; i < Math.min(5, cellCount); i++) {
      await gridCells.nth(i * Math.floor(cellCount / 5 || 1)).hover();
      await page.waitForTimeout(50);
    }
    const badColors = await page.evaluate(() => {
      const cells = document.querySelectorAll('[data-testid="pane-right"] [data-cell-idx]');
      let bad = 0;
      for (const c of cells) {
        if ((c.style.backgroundColor || '').includes('NaN')) bad++;
      }
      return bad;
    });
    h.check('no rgb(NaN,...) cell colors in grid', badColors === 0, `bad=${badColors}`);
  }

  h.check('no console/page errors observed', issues.console.length === 0 && issues.pageerror.length === 0,
    JSON.stringify([...issues.console, ...issues.pageerror]));

  await browser.close();
  h.finish();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
