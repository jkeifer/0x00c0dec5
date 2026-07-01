import { chromium } from 'playwright';

const URL = 'http://localhost:5173/0x00c0dec5/';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();

const consoleMsgs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    consoleMsgs.push(`[console.${m.type()}] ${m.text()}`);
  }
});
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.stack || e.message}`));

await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(1500);

await page.screenshot({ path: 'tests/ui/screenshots/01-initial.png', fullPage: false });

// Dump some basic DOM facts
const sections = await page.locator('text=/^(SCHEMA|CHUNK|INTERLEAVE|CODECS|METADATA|WRITE|READ)$/i').count();
console.log('Sidebar section labels found:', sections);

const selects = await page.locator('select').count();
console.log('select elements:', selects);

// pane dropdowns: list all selects with options
const selectInfo = await page.$$eval('select', (els) =>
  els.map((el, i) => ({ i, value: el.value, options: [...el.options].map((o) => o.value) }))
);
console.log(JSON.stringify(selectInfo, null, 2));

// Radios / buttons text inventory
const buttons = await page.$$eval('button', (els) => els.map((el) => el.textContent.trim()).filter(Boolean));
console.log('buttons:', JSON.stringify(buttons));

const inputs = await page.$$eval('input', (els) =>
  els.map((el) => ({ type: el.type, value: el.value, checked: el.checked, name: el.name, placeholder: el.placeholder }))
);
console.log('inputs:', JSON.stringify(inputs, null, 2));

console.log('--- CONSOLE ISSUES ---');
console.log(consoleMsgs.length ? consoleMsgs.join('\n') : '(none)');

await browser.close();
