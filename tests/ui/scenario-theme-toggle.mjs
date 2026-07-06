// Regression scenario: light/dark/system theme (plan Phase 4).
//
// Covers:
//  - fresh load with pref 'system' resolves via prefers-color-scheme (the
//    index.html blocking script + uiPrefs both write the *resolved* theme to
//    <html data-theme>);
//  - the header theme-toggle cycles Dark -> Light -> System and actually
//    restyles the page (computed body background changes);
//  - a seeded '0x00c0dec5-ui-prefs' {theme:'light'} loads light regardless of
//    the OS scheme, independently of any seeded config state.
//
// Run: node tests/ui/scenario-theme-toggle.mjs   (dev server must be running)

import { chromium } from 'playwright';
import { newContext, seedStateAndReload, safeReload, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-theme-toggle');

async function dataTheme(page) {
  return page.evaluate(() => document.documentElement.dataset.theme || null);
}

async function bodyBg(page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function main() {
  const browser = await chromium.launch();

  // ── System preference resolution on fresh load ────────────────────────────
  {
    const { page, issues } = await newContext(browser, { fresh: true });

    await page.emulateMedia({ colorScheme: 'light' });
    await safeReload(page);
    await page.waitForTimeout(500);
    h.check(
      "fresh load with OS light scheme resolves to html[data-theme='light']",
      (await dataTheme(page)) === 'light',
      `data-theme=${await dataTheme(page)}`,
    );

    await page.emulateMedia({ colorScheme: 'dark' });
    await safeReload(page);
    await page.waitForTimeout(500);
    h.check(
      "fresh load with OS dark scheme resolves to html[data-theme='dark']",
      (await dataTheme(page)) === 'dark',
      `data-theme=${await dataTheme(page)}`,
    );

    // ── Toggle cycling: System -> Dark -> Light ─────────────────────────────
    const darkBg = await bodyBg(page);
    await shot(page, 'theme-toggle-dark');

    const toggle = page.locator('[data-testid="theme-toggle"]');
    h.check(
      "toggle label shows the current preference ('System' on fresh load)",
      /System/.test(await toggle.innerText()),
      await toggle.innerText(),
    );

    await toggle.click(); // system -> dark (attribute stays 'dark')
    await page.waitForTimeout(100);
    const afterFirst = await dataTheme(page);
    await toggle.click(); // dark -> light
    await page.waitForTimeout(300);
    const afterSecond = await dataTheme(page);
    const lightBg = await bodyBg(page);
    await shot(page, 'theme-toggle-light');

    h.check(
      "clicking the toggle cycles System -> Dark -> Light (data-theme flips to 'light')",
      afterFirst === 'dark' && afterSecond === 'light',
      `afterFirst=${afterFirst} afterSecond=${afterSecond}`,
    );
    h.check(
      'computed body background actually changes between dark and light themes',
      darkBg !== lightBg,
      `dark=${darkBg} light=${lightBg}`,
    );
    h.check(
      "toggle label updates to 'Light'",
      /Light/.test(await toggle.innerText()),
      await toggle.innerText(),
    );

    // The choice persists across reload (still under an OS-dark emulation).
    await safeReload(page);
    await page.waitForTimeout(500);
    h.check(
      'explicit light preference survives reload despite OS dark scheme',
      (await dataTheme(page)) === 'light',
      `data-theme=${await dataTheme(page)}`,
    );

    h.check(
      'no console errors or page errors during theme toggling',
      issues.pageerror.length === 0 &&
        issues.console.filter((m) => m.startsWith('[console.error]')).length === 0,
      `pageerrors=${issues.pageerror.length} consoleErrors=${issues.console.length}`,
    );
    await page.context().close();
  }

  // ── Seeded ui-prefs apply independently of seeded config state ────────────
  {
    const { page, issues } = await newContext(browser, { fresh: true });
    await page.emulateMedia({ colorScheme: 'dark' }); // pref must win over OS

    // Minimal valid tabular config (same seed shape scenario-crash-inputs
    // uses) alongside the ui-prefs key — the two stores must not interfere.
    const tabularState = {
      variables: [{ id: 'a', name: 'a', dtype: 'float32', color: '#e06c75' }],
      shape: [32],
      chunkShape: [32],
      interleaving: 'column',
      fieldPipelines: { a: [] },
      chunkPipeline: [],
      metadata: { customEntries: [], serialization: 'json' },
      write: {
        magicNumber: '00C0DEC5',
        partitioning: 'single',
        metadataPlacement: 'header',
        chunkOrder: 'row-major',
      },
    };
    await seedStateAndReload(page, {
      '0x00c0dec5-ui-prefs': JSON.stringify({ theme: 'light' }),
      '0x00c0dec5-state-tabular': tabularState,
    });
    await page.waitForTimeout(1200);
    await shot(page, 'theme-toggle-seeded-light');

    h.check(
      "seeded {theme:'light'} ui-prefs load light despite OS dark scheme",
      (await dataTheme(page)) === 'light',
      `data-theme=${await dataTheme(page)}`,
    );
    h.check(
      'seeded config state applies alongside seeded ui-prefs (variable "a" visible)',
      (await page.locator('input[placeholder="name"][value="a"]').count()) > 0,
    );
    h.check(
      'no console errors or page errors with seeded prefs + config',
      issues.pageerror.length === 0 &&
        issues.console.filter((m) => m.startsWith('[console.error]')).length === 0,
      `pageerrors=${issues.pageerror.length} consoleErrors=${issues.console.length}`,
    );
    await page.context().close();
  }

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
