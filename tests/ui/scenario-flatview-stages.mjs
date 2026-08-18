// Ad-hoc verification for task 4.4 (docs/remediation-plan.md, Phase 4, UI-6):
// view-mode lists now offer Hex+Flat for every non-Values stage, and Flat
// mode must render gracefully for stages with degenerate/structural traces
// (Metadata: all bytes traceId 'metadata'; Write: magic/metadata/chunk
// traces mixed). This is a throwaway manual verification script (not part
// of the named scenario-*.mjs regression suite) — just drives the right
// pane through each stage in Flat mode and screenshots it.
//
// Run: node tests/ui/scenario-flatview-stages.mjs   (dev server must be running)

import { launch, shot } from './scenario-helpers.mjs';

const STAGES = ['linearized', 'encoded', 'metadata', 'write', 'read'];

async function main() {
  const { browser, page } = await launch({ fresh: true });

  // Read fails by default (metadata.enabled is off in the starter config) —
  // enable it so the 'read' case below exercises the success path (mixed
  // magic/metadata/chunk traces reconstructed) rather than the failure panel.
  await page.click('[data-testid="metadata-enabled-toggle"] >> text=Yes');
  await page.waitForTimeout(300);

  for (const stageName of STAGES) {
    // Drive the right pane's dropdown + Flat radio directly via React's
    // controlled <select>/<input> so the app's own state updates (native
    // Playwright selectOption + click keeps this in sync with real events).
    await page.selectOption('[data-testid="pane-dropdown-right"]', stageName);
    await page.waitForTimeout(200);
    await page.click('[data-testid="pane-right"] [data-testid="view-mode-flat"]');
    await page.waitForTimeout(300);

    const flatVisible = (await page.locator('[data-testid="pane-right"] [data-testid="flat-view"]').count()) > 0;
    const rowCount = await page.locator('[data-testid="pane-right"] [data-testid="flat-view"] > div > div').count();
    const firstRowText = rowCount > 0
      ? await page.locator('[data-testid="pane-right"] [data-testid="flat-view"] > div > div').first().innerText()
      : '(no rows)';

    console.log(`[${stageName}] flatVisible=${flatVisible} rowCount=${rowCount} firstRow=${JSON.stringify(firstRowText)}`);

    await shot(page, `flatview-${stageName}`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
