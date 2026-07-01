// Shared helpers for tests/ui/scenario-*.mjs regression scenarios.
//
// Conventions:
//   - Each scenario is a standalone `node tests/ui/scenario-<name>.mjs` script.
//   - Checks are recorded via a runChecks-style harness: PASS, FAIL, or KNOWN-FAIL.
//   - KNOWN-FAIL marks a documented, already-tracked defect from
//     docs/remediation-plan.md (Part 1 findings) that a later phase fixes. It does
//     NOT fail the harness — it prints loudly and the process still exits 0.
//   - A check that was expected to be a KNOWN-FAIL but actually PASSED is reported
//     as UNEXPECTED (the underlying bug may have been fixed — re-check the phase
//     plan and flip the scenario's expectation), and DOES fail the harness, since
//     that's a signal worth surfacing rather than silently swallowing.
//   - Any other unexpected FAIL exits nonzero.

import { chromium } from 'playwright';

export const BASE_URL = 'http://localhost:5173/0x00c0dec5/';
export const SCREEN_DIR = new URL('./screenshots/', import.meta.url).pathname;

/**
 * Launch a browser + fresh (or not) page/context with console/pageerror capture.
 */
export async function newContext(browser, { fresh = true, viewport = { width: 1600, height: 950 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const issues = { console: [], pageerror: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      issues.console.push(`[console.${m.type()}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => issues.pageerror.push(`[pageerror] ${e.stack || e.message}`));
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  if (fresh) {
    await safeEvaluate(page, () => localStorage.clear());
    await safeReload(page);
  }
  await page.waitForTimeout(1000);
  return { ctx, page, issues };
}

/**
 * page.evaluate() can throw "Execution context was destroyed" if it races a
 * Vite dev-server navigation/reload. Retry a couple of times — again, a test
 * harness timing issue rather than a defect under test.
 */
export async function safeEvaluate(page, fn, arg, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn, arg);
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(300);
    }
  }
  throw lastErr;
}

/**
 * page.reload() occasionally races with Vite's dev-server module graph and throws
 * "net::ERR_ABORTED; maybe frame was detached?". Retry a couple of times before
 * giving up — this is a test-harness timing issue, not a defect under test.
 */
export async function safeReload(page, { retries = 2, timeout = 10000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      await page.reload({ timeout, waitUntil: 'load' });
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(300);
    }
  }
  throw lastErr;
}

/** Convenience: launch a browser and a single fresh context/page in one call. */
export async function launch(opts = {}) {
  const browser = await chromium.launch();
  const { ctx, page, issues } = await newContext(browser, opts);
  return { browser, ctx, page, issues };
}

export async function shot(page, name) {
  await page.screenshot({ path: `${SCREEN_DIR}${name}.png` });
}

export async function bodyRendered(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  return text.length > 20;
}

export async function boundaryShown(page) {
  return (await page.locator('text=Something went wrong').count()) > 0;
}

/**
 * A small results harness. Create one per scenario file, call `.check(...)` /
 * `.knownFail(...)` for each assertion, then `.finish()` at the end.
 *
 * - check(name, pass, detail): expects pass === true. Records PASS/FAIL.
 * - knownFail(name, currentlyPasses, detail, ref): the assertion is expected to
 *   currently FAIL (documented defect `ref`, e.g. "RP-1"). If currentlyPasses is
 *   false (i.e. the bug still reproduces), records KNOWN-FAIL and does not affect
 *   exit code. If currentlyPasses is true (bug appears fixed), records UNEXPECTED
 *   and DOES affect exit code, with a loud message telling the operator to update
 *   the scenario's expectation.
 */
export function createHarness(scenarioName) {
  const results = [];

  function check(name, pass, detail = '') {
    results.push({ name, status: pass ? 'PASS' : 'FAIL', detail });
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  }

  function knownFail(name, currentlyPasses, detail = '', ref = '') {
    if (currentlyPasses) {
      results.push({ name, status: 'UNEXPECTED', detail });
      console.log(
        `[UNEXPECTED] ${name} - expected KNOWN-FAIL (${ref}) but it PASSED. ` +
        `The underlying fix may have landed — flip this scenario's expectation. ${detail}`,
      );
    } else {
      results.push({ name, status: 'KNOWN-FAIL', detail });
      console.log(`[KNOWN-FAIL] ${name} (${ref}) - ${detail}`);
    }
  }

  function finish() {
    console.log(`\n=== ${scenarioName}: SUMMARY ===`);
    for (const r of results) {
      console.log(`${r.status}: ${r.name}`);
    }
    const bad = results.filter((r) => r.status === 'FAIL' || r.status === 'UNEXPECTED');
    if (bad.length > 0) {
      console.log(`\n${bad.length} unexpected result(s).`);
      process.exitCode = 1;
    } else {
      console.log('\nAll checks PASS or KNOWN-FAIL as expected.');
      process.exitCode = 0;
    }
    return bad.length === 0;
  }

  return { check, knownFail, finish, results };
}

/** Read the DOM background-color of an element handle (or null). */
export async function bgColor(locator) {
  return locator.evaluate((el) => el.style.backgroundColor || null).catch(() => null);
}

/** Count elements under a root selector whose inline background-color contains a substring. */
export async function countHighlighted(page, rootSelector, substring) {
  return page.evaluate(
    ({ rootSelector, substring }) => {
      const root = document.querySelector(rootSelector);
      if (!root) return 0;
      const els = [...root.querySelectorAll('*')];
      return els.filter((el) => (el.style.backgroundColor || '').includes(substring)).length;
    },
    { rootSelector, substring },
  );
}
