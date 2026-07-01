import { launch, report, shot } from './helper.mjs';

const { browser, page, issues } = await launch();

// --- 1. Change rows to 64 ---
const rowsInput = page.locator('input[type=number]').first();
await rowsInput.fill('64');
await page.waitForTimeout(600);
await shot(page, '02-rows-64');
report('rows=64', issues);

// --- 2. Switch to N-d Array model ---
await page.locator('button', { hasText: 'N-d Array' }).click();
await page.waitForTimeout(600);
await shot(page, '03-nd-array');
report('toggle N-d array', issues);

// --- 3. Add a dim => 2D shape, set 8,8 ---
await page.locator('button', { hasText: '+ Dim' }).click();
await page.waitForTimeout(300);
// now shape inputs: Dim 0, Dim 1 in Schema section. Fill them.
const dim0 = page.locator('input[type=number]').nth(0);
await dim0.fill('8');
await page.waitForTimeout(200);
const dim1 = page.locator('input[type=number]').nth(1);
await dim1.fill('8');
await page.waitForTimeout(600);
await shot(page, '04-shape-8x8');
report('shape 8x8', issues);

// Grid view on 2D data
await page.locator('button', { hasText: /^Grid$/ }).first().click();
await page.waitForTimeout(500);
await shot(page, '05-grid-2d');
report('grid view 2d', issues);

// --- 4. Toggle back to tabular ---
await page.locator('button', { hasText: 'Tabular' }).click();
await page.waitForTimeout(600);
await shot(page, '06-back-tabular');
report('back to tabular', issues);

// dump state of shape/chunk display
const chunkText = await page.locator('text=/Grid:/').textContent().catch(() => 'n/a');
const chunkCount = await page.locator('text=/chunks?$/').first().textContent().catch(() => 'n/a');
console.log('chunk grid:', chunkText, '| count:', chunkCount);

// --- 5. Add a variable ---
await page.locator('button', { hasText: '+ Variable' }).click();
await page.waitForTimeout(500);
await shot(page, '07-added-variable');
report('add variable (empty name)', issues);

// name it
const nameInputs = page.locator('input[placeholder=name]');
const n = await nameInputs.count();
await nameInputs.nth(n - 1).fill('wind');
await page.waitForTimeout(500);
report('name new variable', issues);

// --- 6. Change a dtype: humidity uint16 -> int8 ---
const dtypeSelects = page.locator('select');
// find dtype selects (options include float32)
const allSelects = await page.$$('select');
let dtypeIdx = -1;
for (let i = 0; i < allSelects.length; i++) {
  const opts = await allSelects[i].$$eval('option', (os) => os.map((o) => o.value));
  if (opts.includes('float32') && opts.includes('uint16')) { dtypeIdx = i; break; }
}
console.log('first dtype select at index', dtypeIdx);
await dtypeSelects.nth(dtypeIdx).selectOption('int16');
await page.waitForTimeout(600);
await shot(page, '08-dtype-int16');
report('change dtype float32->int16', issues);

// --- 7. Remove the added variable ---
const removeButtons = page.locator('button', { hasText: /^x$/ });
const rc = await removeButtons.count();
await removeButtons.nth(rc - 1).click();
await page.waitForTimeout(500);
await shot(page, '09-removed-variable');
report('remove variable', issues);

// --- 8. Remove ALL variables (edge case) ---
while ((await page.locator('button', { hasText: /^x$/ }).count()) > 0) {
  await page.locator('button', { hasText: /^x$/ }).first().click();
  await page.waitForTimeout(300);
}
await page.waitForTimeout(500);
await shot(page, '10-zero-variables');
report('zero variables', issues);

await browser.close();
