import { launch, report, shot } from './helper.mjs';

const { browser, page, issues } = await launch();

// fresh state: right pane stage state = -1 (Read), dropdown displays ???
const selVal = await page.locator('#right-pane select').inputValue();
console.log('right select DOM value:', JSON.stringify(selVal));
const shown = await page.evaluate(() => {
  const sel = document.querySelector('#right-pane select');
  return { selectedIndex: sel.selectedIndex, text: sel.options[sel.selectedIndex]?.text ?? '(none)' };
});
console.log('right select shows:', JSON.stringify(shown));
const paneShowsReadError = await page.locator('#right-pane :text("Cannot read file")').count();
console.log('right pane shows read-failure content:', paneShowsReadError);

// try selecting "Values" (option 0) via real user interaction
await page.locator('#right-pane select').selectOption({ index: 0 });
await page.waitForTimeout(500);
const paneAfter = await page.locator('#right-pane :text("Cannot read file")').count();
const selValAfter = await page.locator('#right-pane select').inputValue();
console.log('after selecting Values: select value =', selValAfter, '| still read error?', paneAfter);
await shot(page, '55-select-values-right');
report('dropdown mismatch', issues);

// magic 'GG' (even length, non-hex) — silent corruption check
await page.locator('input[value="00C0DEC5"]').fill('GGGG');
await page.waitForTimeout(700);
report('magic GGGG', issues);
// check write stage hex first bytes
await page.selectOption('#left-pane select', '5');
await page.waitForTimeout(500);
const firstRow = await page.locator('#left-pane :text("0000")').first().locator('..').textContent().catch(() => 'n/a');
console.log('write hex row 0 with magic GGGG:', firstRow.slice(0, 80));
await shot(page, '56-magic-gggg');
report('magic GGGG write view', issues);

await browser.close();
