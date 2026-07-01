import { launch, report, shot } from './helper.mjs';

const { browser, page, issues } = await launch();

// left = Values/table (default). right = Typed/hex
await page.selectOption('#right-pane select', '1');
await page.waitForTimeout(300);
await page.locator('#right-pane button', { hasText: /^Hex$/ }).click();
await page.waitForTimeout(400);

// hover a temperature cell in left table (row 6 value -47.7)
await page.locator('#left-pane :text("-47.7")').first().hover();
await page.waitForTimeout(500);
await shot(page, '30-hover-table-cell');

const hoverBar = await page.locator('text=Hover a value').count()
  ? 'still placeholder'
  : 'changed';
// hover bar is just above panes; grab its text via the element that contained placeholder
const barText = await page.evaluate(() => {
  // find element whose text starts with something other than default; the HoverBar is the div after pipeline strip
  const all = [...document.querySelectorAll('div')];
  const el = all.find((d) => d.childElementCount === 0 && /trace|→|Values|byte/i.test(d.textContent) && d.textContent.length < 300 && d.offsetHeight < 40 && d.offsetTop < 200 && d.offsetTop > 60);
  return el ? el.textContent : '(not found)';
});
console.log('hover bar state:', hoverBar, '| text:', barText);

// count highlighted bytes in right pane
const highlighted = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('#right-pane span')];
  return spans.filter((s) => s.style.backgroundColor === 'rgba(255, 255, 255, 0.18)').length;
});
console.log('highlighted spans in right hex:', highlighted);
report('hover table cell', issues);

// --- reverse: hover a hex byte in right pane ---
// move mouse away first
await page.mouse.move(10, 10);
await page.waitForTimeout(300);
const hexByte = page.locator('#right-pane span', { hasText: /^CD$/ }).first();
await hexByte.hover();
await page.waitForTimeout(500);
await shot(page, '31-hover-hex-byte');

const tableHighlighted = await page.evaluate(() => {
  const els = [...document.querySelectorAll('#left-pane div, #left-pane span')];
  return els.filter((s) => s.style && (s.style.backgroundColor || '').includes('0.18')).length;
});
console.log('highlighted elements in left table:', tableHighlighted);
const barText2 = await page.evaluate(() => {
  const all = [...document.querySelectorAll('div')];
  const el = all.find((d) => d.childElementCount === 0 && /trace|→|byte/i.test(d.textContent) && d.textContent.length < 300 && d.offsetHeight < 40 && d.offsetTop < 200 && d.offsetTop > 60);
  return el ? el.textContent : '(not found)';
});
console.log('hover bar after hex hover:', barText2);
report('hover hex byte', issues);

// --- hover across entropy codec: add rle to temperature, right pane Encoded hex, hover table cell ---
await page.locator('select', { hasText: '+ Add codec' }).first().selectOption('rle');
await page.waitForTimeout(500);
await page.selectOption('#right-pane select', '3'); // Encoded
await page.waitForTimeout(400);
await page.mouse.move(10, 10);
await page.locator('#left-pane :text("-47.7")').first().hover();
await page.waitForTimeout(500);
await shot(page, '32-hover-after-rle');
const chunkHighlighted = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('#right-pane span')];
  return {
    value: spans.filter((s) => s.style.backgroundColor === 'rgba(255, 255, 255, 0.18)').length,
    chunk: spans.filter((s) => s.style.backgroundColor === 'rgba(255, 255, 255, 0.08)').length,
  };
});
console.log('after RLE — value-level:', chunkHighlighted.value, 'chunk-level:', chunkHighlighted.chunk);
report('hover across entropy codec', issues);

await browser.close();
