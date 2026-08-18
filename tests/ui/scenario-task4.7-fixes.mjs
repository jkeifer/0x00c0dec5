// Spot-check scenario for Phase 4 task 4.7's small-fixes batch (this agent's
// slice): UI-16 (HoverBar structural-trace labels) and UI-17 (sidebar
// minimum width). Run: node tests/ui/scenario-task4.7-fixes.mjs
// (dev server must be running at BASE_URL).

import { launch, shot } from './scenario-helpers.mjs';
import { createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-task4.7-fixes');

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

  // ── UI-16: HoverBar structural-trace labels ──────────────────────────
  // Metadata is off by default (metadata.enabled: false) — turn it on
  // so a 'metadata' trace actually exists in the Write stage's bytes.
  await page
    .locator('[data-testid="sidebar-section-metadata"] [data-testid="metadata-enabled-toggle"] button', { hasText: /^Yes$/ })
    .click();
  await page.waitForTimeout(300);

  // Put the right pane on the Write stage / Hex view, so the first bytes are
  // the magic-number bytes (traceId 'magic:start').
  await setPaneStage(page, 'right', 'write');
  await setPaneViewMode(page, 'right', 'Hex');

  const firstByte = page.locator('[data-testid="pane-right"] [data-testid^="hex-byte-"]').first();
  await firstByte.hover();
  await page.waitForTimeout(300);

  const hoverBarText = await page.locator('[data-testid="hover-bar"]').innerText();
  console.log('Hover bar text (magic byte):', JSON.stringify(hoverBarText));
  h.check(
    'UI-16: hovering a magic byte shows a "magic number" label, not blank',
    hoverBarText.includes('magic number'),
    hoverBarText,
  );
  h.check(
    'UI-16: hovering a magic byte does not show a redundant "= magic (start)" value',
    !hoverBarText.includes('= magic'),
    hoverBarText,
  );

  await shot(page, 'task4.7-ui16-hoverbar-magic');

  // Now find a metadata byte. With includeMetadata on and header placement
  // (the default), metadata bytes follow the header magic. Scan a handful of
  // later hex bytes for one whose hover bar says "metadata".
  const hexBytes = page.locator('[data-testid="pane-right"] [data-testid^="hex-byte-"]');
  const total = await hexBytes.count();
  let foundMetadata = false;
  let metadataHoverText = '';
  for (let i = 4; i < Math.min(total, 40) && !foundMetadata; i++) {
    await hexBytes.nth(i).hover();
    await page.waitForTimeout(150);
    const text = await page.locator('[data-testid="hover-bar"]').innerText();
    if (text.includes('metadata')) {
      foundMetadata = true;
      metadataHoverText = text;
    }
  }
  console.log('Hover bar text (metadata byte):', JSON.stringify(metadataHoverText));
  h.check(
    'UI-16: hovering a metadata byte shows a "metadata" label',
    foundMetadata,
    metadataHoverText || '(no metadata-labeled byte found in first 40 bytes)',
  );

  await shot(page, 'task4.7-ui16-hoverbar-metadata');

  // ── UI-17: sidebar minimum width at a narrow viewport ────────────────
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(400);

  // Drag the sidebar separator all the way to the left to force the sidebar
  // to its minimum size.
  const separator = page.locator('.resize-handle').first();
  const sepBox = await separator.boundingBox();
  if (sepBox) {
    await page.mouse.move(sepBox.x + sepBox.width / 2, sepBox.y + sepBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(0, sepBox.y + sepBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }

  const sidebarBox = await page.locator('#sidebar, [id="sidebar"]').first().boundingBox()
    .catch(() => null);
  // Panel doesn't render its id as a DOM id by default in some versions; fall back
  // to measuring the first Panel-rendered child via data-panel-group attributes.
  const sidebarWidth = sidebarBox
    ? sidebarBox.width
    : await page.evaluate(() => {
        const el = document.querySelector('[data-panel-id="sidebar"]');
        return el ? el.getBoundingClientRect().width : null;
      });
  console.log('Sidebar width after drag-to-min at 900px viewport:', sidebarWidth);
  h.check(
    'UI-17: sidebar does not shrink below ~200px at 900px window width',
    typeof sidebarWidth === 'number' && sidebarWidth >= 195,
    `sidebarWidth=${sidebarWidth}`,
  );

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  console.log('Document overflow check:', overflow);
  h.check(
    'UI-17: no horizontal overflow at 900px viewport width',
    overflow.scrollWidth <= overflow.clientWidth + 1,
    `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`,
  );

  await shot(page, 'task4.7-ui17-sidebar-900px');

  await browser.close();
  h.finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
