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

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
