import { launch, report, shot } from './helper.mjs';

const { browser, page, issues } = await launch();

// --- chunk shape 8 => 4 chunks ---
const chunkInput = page.locator('input[type=number]').nth(12); // chunk Dim 0 (after 12 schema inputs? verify)
// safer: the chunk input is inside CHUNK section; find by label sibling
const chunkDim = page.locator('div:has(> span:text("Dim 0")) input').first();
await chunkDim.fill('8');
await page.waitForTimeout(600);
const chunkCount = await page.locator('text=/chunks?( |$)/').first().textContent().catch(() => 'n/a');
console.log('chunk count text:', chunkCount);
await shot(page, '11-chunks-4');
report('chunk=8 (4 chunks)', issues);

// --- add codecs to temperature: delta, byte-shuffle, rle, lz ---
const addCodec = page.locator('select', { hasText: '+ Add codec' }).first();
for (const c of ['delta', 'byte-shuffle', 'rle', 'lz']) {
  await addCodec.selectOption(c);
  await page.waitForTimeout(500);
  report(`add codec ${c}`, issues);
}
await shot(page, '12-codecs-added');

// verify pipeline stages updated
const encodedStat = await page.locator('text=Encoded').first().locator('..').textContent();
console.log('Encoded stage node:', encodedStat);

// --- reorder: move rle (index 2) up ---
const upButtons = page.locator('button', { hasText: /^\^$/ });
console.log('up buttons:', await upButtons.count());
await upButtons.nth(2).click(); // move 3rd step up
await page.waitForTimeout(500);
await shot(page, '13-codecs-reordered');
report('reorder codec', issues);

// --- move first step up (disabled) should be no-op ---
await upButtons.nth(0).click({ force: true }).catch(() => {});
await page.waitForTimeout(300);
report('click disabled up', issues);

// --- remove a step: find x buttons within codec section (after variable x buttons: 3 vars) ---
const xButtons = page.locator('button', { hasText: /^x$/ });
const xc = await xButtons.count();
console.log('x buttons total:', xc);
// codec steps are the last 4 x buttons
await xButtons.nth(xc - 1).click();
await page.waitForTimeout(500);
await shot(page, '14-codec-removed');
report('remove codec step', issues);

// --- switch interleave to Row-oriented ---
await page.locator('button', { hasText: 'Row-oriented' }).click();
await page.waitForTimeout(600);
await shot(page, '15-row-oriented');
report('interleave row', issues);

// --- back to Column ---
await page.locator('button', { hasText: 'Column-oriented' }).click();
await page.waitForTimeout(600);
await shot(page, '16-back-column');
report('interleave back to column', issues);

// check codec steps preserved
const codecLabels = await page.locator('text=/Delta encoding|Byte shuffle|Run-length|LZ/i').allTextContents().catch(() => []);
console.log('codec labels visible after round-trip:', JSON.stringify(codecLabels));

await browser.close();
