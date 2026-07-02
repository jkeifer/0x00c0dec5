// Regression scenario: codec applicability warnings (task 4.3, UI-4/SW-7).
//
// Verifies:
//  1. Adding delta to a float32 variable (temperature) shows a ⚠ in the
//     CodecPipelineEditor step AND in the PipelineStrip's Encoded stage node.
//  2. Adding byte-shuffle with an elementSize that doesn't match the input
//     dtype's size shows a ⚠ with the "element size doesn't match" message.
//  3. Adding delta to humidity (uint16 — integer dtype, exact/lossless) shows
//     no ⚠ anywhere.
//
// Run: node tests/ui/scenario-codec-warnings.mjs
// (point BASE_URL_OVERRIDE at whichever dev server port is live)

import { createHarness } from './scenario-helpers.mjs';
import { chromium } from 'playwright';

const BASE_URL = process.env.SCENARIO_BASE_URL || 'http://localhost:5173/0x00c0dec5/';
const SCREEN_DIR = new URL('./screenshots/', import.meta.url).pathname;

const h = createHarness('scenario-codec-warnings');

async function shot(page, name) {
  await page.screenshot({ path: `${SCREEN_DIR}${name}.png` });
}

async function openSidebarSection(page, slug) {
  const section = page.locator(`[data-testid="sidebar-section-${slug}"]`);
  await section.scrollIntoViewIfNeeded();
  return section;
}

async function addCodec(page, variableSlot, codecLabel) {
  // CodecSection renders one CodecPipelineEditor per variable (column mode),
  // each ending in an "+ Add codec" <select data-testid unset>. Locate the
  // add-select that is scoped under the variable's codec block by walking up
  // from the last codec-step for that slot, or — if there are no steps yet —
  // by proximity to the variable's name label. Simplest robust approach:
  // there is one <select> with option "+ Add codec" per variable block;
  // count existing steps for this slot to find the right one positionally.
  const existingSteps = await page.locator(`[data-testid^="codec-step-${variableSlot}-"]`).count();
  const addSelects = page.locator('select', { hasText: '+ Add codec' });
  // Column mode order matches variable order (temperature, pressure, humidity).
  const slotOrder = ['temperature', 'pressure', 'humidity'];
  const idx = slotOrder.indexOf(variableSlot);
  const select = idx >= 0 ? addSelects.nth(idx) : addSelects.first();
  await select.selectOption({ label: codecLabel });
  await page.waitForTimeout(200);
  return existingSteps;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);

  await openSidebarSection(page, 'codecs');
  await shot(page, 'codec-warnings-00-initial-codecs-section');

  // ── 1. Delta on temperature (float32) — should warn ──
  await addCodec(page, 'temperature', 'Delta');
  await page.waitForTimeout(200);

  const tempWarningIcon = page.locator('[data-testid="codec-warning-temperature-0"]');
  const tempWarningVisible = await tempWarningIcon.count();
  h.check('editor: delta on temperature (float32) shows ⚠', tempWarningVisible > 0);

  let tempWarningTitle = '';
  if (tempWarningVisible > 0) {
    tempWarningTitle = (await tempWarningIcon.getAttribute('title')) || '';
  }
  h.check(
    'editor: temperature ⚠ tooltip mentions lossy',
    /lossy/i.test(tempWarningTitle),
    tempWarningTitle,
  );

  const stripWarningAfterTemp = await page.locator('[data-testid="pipeline-stage-encoded-warning"]').count();
  h.check('strip: Encoded stage shows ⚠ after delta-on-temperature', stripWarningAfterTemp > 0);
  let stripTitleAfterTemp = '';
  if (stripWarningAfterTemp > 0) {
    stripTitleAfterTemp = (await page.locator('[data-testid="pipeline-stage-encoded-warning"]').getAttribute('title')) || '';
  }
  h.check(
    'strip: Encoded ⚠ tooltip mentions lossy',
    /lossy/i.test(stripTitleAfterTemp),
    stripTitleAfterTemp,
  );

  await shot(page, 'codec-warnings-01-delta-temperature');

  // ── 2. Byte Shuffle with mismatched elementSize ──
  await addCodec(page, 'pressure', 'Byte Shuffle');
  await page.waitForTimeout(200);

  // pressure is float32 (4 bytes); force elementSize to 3 (mismatch).
  const pressureStep = page.locator('[data-testid="codec-step-pressure-0"]');
  const elementSizeInput = pressureStep.locator('input[type="number"]').first();
  await elementSizeInput.fill('3');
  await elementSizeInput.blur();
  await page.waitForTimeout(200);

  const pressureWarningIcon = page.locator('[data-testid="codec-warning-pressure-0"]');
  const pressureWarningVisible = await pressureWarningIcon.count();
  h.check('editor: byte-shuffle elementSize=3 on float32 (size 4) shows ⚠', pressureWarningVisible > 0);
  let pressureTitle = '';
  if (pressureWarningVisible > 0) {
    pressureTitle = (await pressureWarningIcon.getAttribute('title')) || '';
  }
  h.check(
    'editor: mismatch tooltip says "doesn\'t match dtype size"',
    pressureTitle.includes("doesn't match dtype size"),
    pressureTitle,
  );

  await shot(page, 'codec-warnings-02-shuffle-mismatch');

  // Fix elementSize to 4 — warning should disappear.
  await elementSizeInput.fill('4');
  await elementSizeInput.blur();
  await page.waitForTimeout(200);
  const pressureWarningAfterFix = await page.locator('[data-testid="codec-warning-pressure-0"]').count();
  h.check('editor: warning clears once elementSize matches dtype size', pressureWarningAfterFix === 0);

  await shot(page, 'codec-warnings-03-shuffle-fixed');

  // ── 3. Delta on humidity (uint16) — no warning ──
  await addCodec(page, 'humidity', 'Delta');
  await page.waitForTimeout(200);

  const humidityWarningIcon = page.locator('[data-testid="codec-warning-humidity-0"]');
  const humidityWarningVisible = await humidityWarningIcon.count();
  h.check('editor: delta on humidity (uint16) shows no ⚠', humidityWarningVisible === 0);

  await shot(page, 'codec-warnings-04-delta-humidity-no-warning');

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  h.check('no page errors thrown during scenario', consoleErrors.length === 0, consoleErrors.join('; '));

  await browser.close();
  const ok = h.finish();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
