import { launch, report, shot } from './helper.mjs';

const { browser, page, issues } = await launch();

// enable include metadata (JSON serialization default)
await page.locator('button', { hasText: /^Yes$/ }).first().click();
await page.waitForTimeout(500);
console.log('header+json read ok:', await page.locator('text=File parsed successfully').count());

// footer + JSON
await page.locator('button', { hasText: /^Footer$/ }).click();
await page.waitForTimeout(600);
console.log('footer+json read ok:', await page.locator('text=File parsed successfully').count());
await shot(page, '51-footer-json');

// footer + Binary
await page.locator('button', { hasText: /^Binary$/ }).click();
await page.waitForTimeout(600);
console.log('footer+binary read ok:', await page.locator('text=File parsed successfully').count());

// header + Binary
await page.locator('button', { hasText: /^Header$/ }).click();
await page.waitForTimeout(600);
console.log('header+binary read ok:', await page.locator('text=File parsed successfully').count());
report('placement/serialization matrix', issues);

// --- crash persistence test: set magic to ZZZ, wait for debounce save, reload ---
await page.locator('input[value="00C0DEC5"]').fill('ZZZ');
await page.waitForTimeout(1200); // debounced save 500ms
report('after ZZZ (expected crash)', issues);
await page.reload();
await page.waitForTimeout(1500);
const bodyText = await page.evaluate(() => document.body.innerText.length);
console.log('body text length after reload:', bodyText);
await shot(page, '52-after-reload-crash');
report('reload after crash', issues);

await browser.close();

// --- fresh session, small viewport ---
const { browser: b2, page: p2, issues: i2 } = await launch({ width: 1100, height: 700 });
await shot(p2, '53-small-1100x700');
// check overflow
const overflow = await p2.evaluate(() => ({
  docW: document.documentElement.scrollWidth,
  winW: window.innerWidth,
  docH: document.documentElement.scrollHeight,
  winH: window.innerHeight,
}));
console.log('overflow check:', JSON.stringify(overflow));
report('small viewport', i2);

// even smaller
await p2.setViewportSize({ width: 800, height: 600 });
await p2.waitForTimeout(600);
await shot(p2, '54-tiny-800x600');
report('tiny viewport', i2);

await b2.close();
