// Regression scenario: default pane state on a fresh load (no localStorage).
//
// KNOWN-FAIL SW-2 (docs/remediation-plan.md Part 1, "State & wiring"): the default
// `rightPaneStage` is the `-1` sentinel. `StagePane` resolves -1 to the *last* stage
// (Read) for rendering, but passes the raw -1 through to the `<select value>`, which
// matches no `<option>`, so the browser falls back to showing the first option's
// label ("Values") while the pane actually renders the Read stage's content (which,
// with fresh defaults, is a read failure — "Cannot read file"). Design intent is
// that the default right pane is Write (see D5 in docs/remediation-plan.md Part 2).
// Fixed by Phase 3.8/4.1. This scenario asserts the mismatch reproduces today; if it
// ever shows dropdown="Write" and pane content=Write, that's reported loudly as
// UNEXPECTED (Phase 3/4 landed — flip the expectation to assert the corrected pair).
//
// Run: node tests/ui/scenario-pane-defaults.mjs   (dev server must be running)

import { launch, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-pane-defaults');

async function main() {
  const { browser, page } = await launch({ fresh: true });
  await shot(page, 'pane-defaults-fresh-load');

  // ── Left pane: should default to Values stage / Table view mode, with data ──
  const leftSelect = page.locator('[data-testid="pane-dropdown-left"]');
  const leftShown = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="pane-dropdown-left"]');
    return { selectedIndex: sel.selectedIndex, text: sel.options[sel.selectedIndex]?.text ?? '(none)' };
  });
  const leftHasTableView = (await page.locator('[data-testid="pane-left"] [data-testid="table-view"]').count()) > 0;
  const leftCellCount = await page.locator('[data-testid="pane-left"] [data-testid^="table-cell-"]').count();

  h.check(
    'left pane dropdown shows "Values" on fresh load',
    leftShown.text === 'Values',
    JSON.stringify(leftShown),
  );
  h.check(
    'left pane renders Table view with data (starter variables populated)',
    leftHasTableView && leftCellCount > 0,
    `hasTableView=${leftHasTableView} cellCount=${leftCellCount}`,
  );
  void leftSelect; // kept for symmetry / future direct interaction if needed

  // ── Right pane: KNOWN-FAIL SW-2 — dropdown lies about what's rendered ──────
  const rightShown = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="pane-dropdown-right"]');
    return { selectedIndex: sel.selectedIndex, text: sel.options[sel.selectedIndex]?.text ?? '(none)' };
  });
  const rightRawValue = await page.evaluate(() => {
    // React's `value` prop on the <select> is -1; read the underlying React state
    // indirectly via the DOM attribute the browser actually resolved.
    const sel = document.querySelector('[data-testid="pane-dropdown-right"]');
    return sel.value;
  });
  const rightShowsReadFailure = (await page.locator('[data-testid="pane-right"]', { hasText: 'Cannot read file' }).count()) > 0;
  const rightShowsWriteHex = (await page.locator('[data-testid="pane-right"] [data-testid="write-hex-view"]').count()) > 0
    || (await page.locator('[data-testid="pane-right"] [data-testid="hex-view"]').count()) > 0;

  await shot(page, 'pane-defaults-right-pane-mismatch');

  const dropdownSaysValues = rightShown.text === 'Values';
  const paneRendersReadFailure = rightShowsReadFailure;
  const mismatchReproduces = dropdownSaysValues && paneRendersReadFailure;

  h.knownFail(
    'right pane: dropdown label matches actually-rendered stage content on fresh load',
    !mismatchReproduces, // "currentlyPasses" = true when there's NO mismatch (i.e. bug fixed)
    `dropdown.selectedIndex=${rightShown.selectedIndex} dropdown.text="${rightShown.text}" ` +
      `dropdown.domValue="${rightRawValue}" paneShowsReadFailure=${rightShowsReadFailure} paneShowsWriteHex=${rightShowsWriteHex}`,
    'SW-2 (fix: Phase 3.8/4.1)',
  );

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
