import { chromium } from 'playwright';

export const URL = 'http://localhost:5173/0x00c0dec5/';

export async function launch({ width = 1600, height = 950, fresh = true } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const issues = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      issues.push(`[console.${m.type()}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => issues.push(`[pageerror] ${e.stack || e.message}`));
  await page.goto(URL);
  if (fresh) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  await page.waitForTimeout(1200);
  return { browser, page, issues };
}

export function report(label, issues) {
  console.log(`--- ${label}: ${issues.length ? 'ISSUES' : 'clean'} ---`);
  for (const i of issues) console.log(i);
  issues.length = 0;
}

export async function shot(page, name) {
  await page.screenshot({ path: `tests/ui/screenshots/${name}.png` });
  console.log(`[shot] ${name}`);
}
