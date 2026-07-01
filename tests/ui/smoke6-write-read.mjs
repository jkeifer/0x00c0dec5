import { launch, report, shot } from './helper.mjs';

const { browser, page, issues } = await launch();

// --- Metadata: toggle JSON -> Binary ---
await page.locator('button', { hasText: /^Binary$/ }).click();
await page.waitForTimeout(500);
await shot(page, '40-metadata-binary');
report('metadata binary', issues);
const serText = await page.locator('text=/Serialized:/').textContent().catch(() => 'n/a');
console.log('serialized size (binary):', serText);

// --- add custom metadata entry ---
await page.locator('button', { hasText: '+ Entry' }).click();
await page.waitForTimeout(400);
await page.locator('input[placeholder=key]').last().fill('author');
await page.locator('input[placeholder=value]').last().fill('smoketest');
await page.waitForTimeout(500);
await shot(page, '41-metadata-entry');
report('add metadata entry', issues);

// --- expand auto-collected ---
await page.locator('button', { hasText: 'Auto-collected' }).click();
await page.waitForTimeout(400);
await shot(page, '42-metadata-auto');
report('expand auto-collected', issues);

// --- Write: include metadata = Yes ---
await page.locator('button', { hasText: /^Yes$/ }).first().click();
await page.waitForTimeout(600);
await shot(page, '43-include-metadata');
report('include metadata yes', issues);

// Read status should now be success
const readOk = await page.locator('text=File parsed successfully').count();
const readFail = await page.locator('text=Read failed').count();
console.log('read success visible:', readOk, '| read failed visible:', readFail);

// --- enable diff view, right pane -> Read stage, table ---
await page.selectOption('#right-pane select', '6');
await page.waitForTimeout(300);
await page.locator('#right-pane button', { hasText: /^Table$/ }).click();
await page.waitForTimeout(300);
// diff Yes radio is in Read section (the last Yes button)
await page.locator('button', { hasText: /^Yes$/ }).last().click();
await page.waitForTimeout(600);
await shot(page, '44-diff-view');
report('diff view', issues);

// --- metadata placement Footer ---
await page.locator('button', { hasText: /^Footer$/ }).click();
await page.waitForTimeout(500);
await shot(page, '45-placement-footer');
report('placement footer', issues);
console.log('read after footer:', await page.locator('text=File parsed successfully').count());

// --- Sidecar ---
await page.locator('button', { hasText: /^Sidecar$/ }).click();
await page.waitForTimeout(500);
await shot(page, '46-placement-sidecar');
report('placement sidecar', issues);
console.log('read after sidecar:', await page.locator('text=File parsed successfully').count());
// file explorer should show 2 files
const fileNames = await page.locator('text=/^(data|meta)/').allTextContents().catch(() => []);
console.log('files:', JSON.stringify(fileNames));

// --- per-chunk partitioning (need >1 chunk: set chunk 8) ---
const chunkDim = page.locator('div:has(> span:text("Dim 0")) input').first();
await chunkDim.fill('8');
await page.waitForTimeout(400);
await page.locator('button', { hasText: /^Per-chunk$/ }).click();
await page.waitForTimeout(600);
await shot(page, '47-per-chunk');
report('per-chunk partitioning', issues);
console.log('read after per-chunk:', await page.locator('text=File parsed successfully').count());

// left pane to Write stage to view multi-file hex
await page.selectOption('#left-pane select', '5');
await page.waitForTimeout(500);
await shot(page, '48-write-multifile');
report('write stage multifile view', issues);

// --- change magic number ---
const magic = page.locator('input[value="00C0DEC5"]');
await magic.fill('DEADBEEF');
await page.waitForTimeout(600);
await shot(page, '49-magic-changed');
report('magic number change', issues);
console.log('read after magic change:', await page.locator('text=File parsed successfully').count());

// invalid magic (odd length / non-hex)
await page.locator('input[type=text]').last().fill('ZZZ');
await page.waitForTimeout(600);
await shot(page, '50-magic-invalid');
report('magic number invalid chars', issues);

await browser.close();
