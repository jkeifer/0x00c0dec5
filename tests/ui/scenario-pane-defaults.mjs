// Regression scenario: default pane state on a fresh load.
//
// FIXED SW-2 (docs/remediation-plan.md Part 1, "State & wiring") by Phase 3.8
// (D5): stage identity is now a `StageName`, not a numeric index. The default
// `rightPaneStage` is 'write' (D5's pinned default), and the pane dropdown's
// `<option>` values are stage names, so the browser-selected label always
// matches what's actually rendered — there is no more -1 sentinel / resolved-
// index mismatch to reproduce. This scenario used to carry a KNOWN-FAIL
// assertion documenting that mismatch; it is now flipped to a normal
// PASS-only check per CLAUDE.md's KNOWN-FAIL -> flip convention (the
// underlying fix landed, so re-asserting the bug would itself become an
// UNEXPECTED failure under scenario-helpers.mjs's harness).
//
// Run: node tests/ui/scenario-pane-defaults.mjs   (dev server must be running)

import { launch, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-pane-defaults');

async function main() {
  const { browser, page } = await launch({ fresh: true });
  await shot(page, 'pane-defaults-fresh-load');

  // ── Left pane: should default to Values stage / Table view mode, with data ──
  const leftShown = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="pane-dropdown-left"]');
    return { value: sel.value, text: sel.options[sel.selectedIndex]?.text ?? '(none)' };
  });
  const leftHasTableView = (await page.locator('[data-testid="pane-left"] [data-testid="table-view"]').count()) > 0;
  const leftCellCount = await page.locator('[data-testid="pane-left"] [data-testid^="table-cell-"]').count();

  h.check(
    'left pane dropdown shows "Values" on fresh load',
    leftShown.text === 'Values' && leftShown.value === 'values',
    JSON.stringify(leftShown),
  );
  h.check(
    'left pane renders Table view with data (starter variables populated)',
    leftHasTableView && leftCellCount > 0,
    `hasTableView=${leftHasTableView} cellCount=${leftCellCount}`,
  );

  // ── Right pane: D5 default is 'write', and the dropdown is truthful by ──
  // construction now (option values are stage names bound directly to state).
  const rightShown = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="pane-dropdown-right"]');
    return { value: sel.value, text: sel.options[sel.selectedIndex]?.text ?? '(none)' };
  });
  const rightShowsReadFailure = (await page.locator('[data-testid="pane-right"]', { hasText: 'Cannot read file' }).count()) > 0;
  const rightShowsHex = (await page.locator('[data-testid="pane-right"] [data-testid="write-hex-view"]').count()) > 0
    || (await page.locator('[data-testid="pane-right"] [data-testid="hex-view"]').count()) > 0;

  await shot(page, 'pane-defaults-right-pane');

  h.check(
    'right pane dropdown shows "Write" on fresh load',
    rightShown.text === 'Write' && rightShown.value === 'write',
    JSON.stringify(rightShown),
  );
  h.check(
    'right pane actually renders the Write stage content (hex view of final file bytes), not a Read failure',
    rightShowsHex && !rightShowsReadFailure,
    `rightShowsHex=${rightShowsHex} rightShowsReadFailure=${rightShowsReadFailure}`,
  );

  // ── Task 2 (react-resizable-panels collapsible sidebar/panes) ──
  async function paneWidth(testid) {
    const box = await page.locator(`[data-testid="${testid}"]`).boundingBox();
    return box ? box.width : -1;
  }

  const leftWidthBefore = await paneWidth('pane-left');
  const rightWidthBefore = await paneWidth('pane-right');

  await page.locator('[data-testid="pane-collapse-left"]').click();
  await page.waitForTimeout(300);
  const leftWidthCollapsed = await paneWidth('pane-left');
  const rightWidthAfterLeftCollapse = await paneWidth('pane-right');
  await shot(page, 'pane-defaults-left-collapsed');

  h.check(
    'clicking pane-collapse-left collapses the left pane to <= 40px and the right pane grows',
    leftWidthCollapsed <= 40 && rightWidthAfterLeftCollapse > rightWidthBefore,
    `leftWidthBefore=${leftWidthBefore} leftWidthCollapsed=${leftWidthCollapsed} rightWidthBefore=${rightWidthBefore} rightWidthAfterLeftCollapse=${rightWidthAfterLeftCollapse}`,
  );

  // Clicking again (the rail's expand button, same testid) restores it.
  await page.locator('[data-testid="pane-collapse-left"]').click();
  await page.waitForTimeout(300);
  const leftWidthExpanded = await paneWidth('pane-left');

  h.check(
    'clicking pane-collapse-left again (rail expand button) restores width above 200px',
    leftWidthExpanded > 200,
    `leftWidthExpanded=${leftWidthExpanded}`,
  );

  // Both-collapsed guard: collapse left, then collapse right -> left auto-expands.
  await page.locator('[data-testid="pane-collapse-left"]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid="pane-collapse-right"]').click();
  await page.waitForTimeout(300);
  const leftWidthAfterBothAttempt = await paneWidth('pane-left');
  const rightWidthAfterBothAttempt = await paneWidth('pane-right');
  await shot(page, 'pane-defaults-both-collapse-guard');

  h.check(
    'collapsing right while left is collapsed auto-expands left (both-collapsed guard)',
    leftWidthAfterBothAttempt > 200 && rightWidthAfterBothAttempt <= 40,
    `leftWidthAfterBothAttempt=${leftWidthAfterBothAttempt} rightWidthAfterBothAttempt=${rightWidthAfterBothAttempt}`,
  );

  // Restore right pane before touching the sidebar.
  await page.locator('[data-testid="pane-collapse-right"]').click();
  await page.waitForTimeout(300);

  // Sidebar collapse toggle behaves the same way.
  const sidebarWidthBefore = await paneWidth('sidebar-section-schema').catch(() => -1);
  await page.locator('[data-testid="sidebar-collapse-toggle"]').click();
  await page.waitForTimeout(300);
  const sidebarCollapsedVisible = (await page.locator('[data-testid="sidebar-section-schema"]').count()) === 0;
  await shot(page, 'pane-defaults-sidebar-collapsed');

  h.check(
    'sidebar-collapse-toggle collapses the sidebar (section content no longer rendered)',
    sidebarCollapsedVisible,
    `sidebarWidthBefore=${sidebarWidthBefore} sidebarCollapsedVisible=${sidebarCollapsedVisible}`,
  );

  await page.locator('[data-testid="sidebar-collapse-toggle"]').click();
  await page.waitForTimeout(300);
  const sidebarExpandedVisible = (await page.locator('[data-testid="sidebar-section-schema"]').count()) > 0;

  h.check(
    'sidebar-collapse-toggle again (rail expand button) restores the sidebar',
    sidebarExpandedVisible,
    `sidebarExpandedVisible=${sidebarExpandedVisible}`,
  );

  // No layout overflow at default viewport with panels collapsed.
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 2);
  h.check('no page-level vertical overflow after collapse/expand cycling', !hasOverflow, `scrollHeight=${await page.evaluate(() => document.documentElement.scrollHeight)} innerHeight=${await page.evaluate(() => window.innerHeight)}`);

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
