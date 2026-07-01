import { launch, report, shot } from './helper.mjs';

const { browser, page, issues } = await launch();

const paneSel = (pane) => `#${pane}-pane select`;

async function viewModes(pane) {
  // radio buttons inside the pane controls bar
  return page.locator(`#${pane}-pane button`).allTextContents();
}

// --- iterate all stages in LEFT pane, cycling through each available view mode ---
const stageCount = await page.locator(`${paneSel('left')} option`).count();
console.log('stages:', stageCount);

for (let s = 0; s < stageCount; s++) {
  await page.selectOption(paneSel('left'), String(s));
  await page.waitForTimeout(400);
  const stageName = await page.locator(`${paneSel('left')} option`).nth(s).textContent();
  const modes = await viewModes('left');
  for (const m of modes) {
    await page.locator(`#left-pane button`, { hasText: new RegExp(`^${m}$`) }).click();
    await page.waitForTimeout(400);
    await shot(page, `20-left-s${s}-${stageName.trim()}-${m}`.replace(/\s+/g, ''));
    report(`left stage=${stageName} view=${m}`, issues);
  }
}

// --- iterate all stages in RIGHT pane (default view) ---
for (let s = 0; s < stageCount; s++) {
  await page.selectOption(paneSel('right'), String(s));
  await page.waitForTimeout(400);
  const stageName = await page.locator(`${paneSel('right')} option`).nth(s).textContent();
  report(`right stage=${stageName}`, issues);
}
await shot(page, '21-right-last-stage');

await browser.close();
