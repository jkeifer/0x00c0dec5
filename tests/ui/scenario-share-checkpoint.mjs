// Regression scenario: checkpoint/restore (task 6.4) and shareable state
// URLs (task 6.5), per docs/remediation-plan.md Phase 6.
//
// Part 1 — checkpoint/restore:
//   change shape to 48, save checkpoint, change shape to 16 and add a codec,
//   restore -> shape input shows 48 again and the added codec is gone.
//
// Part 2 — shareable state URL:
//   with shape at 48, click Share, read the copied URL (clipboard-read
//   permission granted on the context, with a stubbed
//   navigator.clipboard.writeText as a fallback capture in case the
//   permission grant doesn't take in this Chromium build), open a NEW page
//   at that URL, assert the state matches (shape 48), and assert the hash is
//   stripped after load.
//
// Run: node tests/ui/scenario-share-checkpoint.mjs   (dev server must be running)

import { launch, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-share-checkpoint');

async function setShape(page, value) {
  const input = page.locator('[data-testid="shape-input"]');
  await input.fill(String(value));
  await input.dispatchEvent('change');
  await page.waitForTimeout(150);
}

async function addCodecToFirstVariable(page) {
  // Column mode (default, tabular): the Codecs sidebar section renders one
  // "+ Add codec" <select> per variable; the first one belongs to the first
  // variable (temperature). It has no dedicated data-testid (only
  // codec-step-* once added), so scope by section + visible placeholder text.
  const section = page.locator('[data-testid="sidebar-section-codecs"]');
  await section.scrollIntoViewIfNeeded();
  const addSelect = section.locator('select').filter({ hasText: '+ Add codec' }).first();
  await addSelect.selectOption('delta');
  await page.waitForTimeout(150);
}

async function main() {
  const { browser, ctx, page } = await launch({ fresh: true });

  // Grant clipboard permissions up front (harmless if the running Chromium
  // ignores clipboard-write, since the Share button also has an
  // execCommand-based fallback and we independently stub writeText below).
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Stub navigator.clipboard.writeText to capture the copied text directly,
  // in addition to (not instead of) exercising the real Share button flow —
  // this makes the assertion robust to headless-Chromium clipboard quirks
  // while still calling the app's real code path.
  await page.evaluate(() => {
    window.__copiedText = null;
    const nav = window.navigator;
    if (!nav.clipboard) {
      Object.defineProperty(nav, 'clipboard', { value: {}, configurable: true });
    }
    nav.clipboard.writeText = async (text) => {
      window.__copiedText = text;
      return Promise.resolve();
    };
  });

  // ─── Part 1: checkpoint / restore ───────────────────────────────────────

  await setShape(page, 48);
  let shapeVal = await page.locator('[data-testid="shape-input"]').inputValue();
  h.check('shape set to 48 before checkpoint', shapeVal === '48', `got "${shapeVal}"`);

  const restoreDisabledBefore = await page.locator('[data-testid="restore-checkpoint"]').isDisabled();
  h.check('restore button starts disabled (no checkpoint yet)', restoreDisabledBefore, `disabled=${restoreDisabledBefore}`);

  await page.locator('[data-testid="save-checkpoint"]').click();
  await page.waitForTimeout(100);

  const saveLabelAfterClick = await page.locator('[data-testid="save-checkpoint"]').innerText();
  h.check(
    'save-checkpoint button shows a brief saved confirmation',
    /Saved/.test(saveLabelAfterClick),
    `label="${saveLabelAfterClick}"`,
  );

  const restoreDisabledAfter = await page.locator('[data-testid="restore-checkpoint"]').isDisabled();
  h.check('restore button becomes enabled after saving a checkpoint', !restoreDisabledAfter, `disabled=${restoreDisabledAfter}`);

  await shot(page, 'share-checkpoint-saved');

  // Mutate: shape to 16, add a codec.
  await setShape(page, 16);
  shapeVal = await page.locator('[data-testid="shape-input"]').inputValue();
  h.check('shape changed to 16 after checkpoint', shapeVal === '16', `got "${shapeVal}"`);

  await addCodecToFirstVariable(page);
  const codecStepsBeforeRestore = await page.locator('[data-testid^="codec-step-temperature-"]').count();
  h.check('a codec step was added to temperature before restore', codecStepsBeforeRestore > 0, `count=${codecStepsBeforeRestore}`);

  // Restore.
  await page.locator('[data-testid="restore-checkpoint"]').click();
  await page.waitForTimeout(200);

  shapeVal = await page.locator('[data-testid="shape-input"]').inputValue();
  h.check('shape input shows 48 after restore', shapeVal === '48', `got "${shapeVal}"`);

  const codecStepsAfterRestore = await page.locator('[data-testid^="codec-step-temperature-"]').count();
  h.check('the added codec is gone after restore', codecStepsAfterRestore === 0, `count=${codecStepsAfterRestore}`);

  await shot(page, 'share-checkpoint-restored');

  // Restore again: repeatable, does not clear the checkpoint.
  await setShape(page, 5);
  await page.locator('[data-testid="restore-checkpoint"]').click();
  await page.waitForTimeout(200);
  shapeVal = await page.locator('[data-testid="shape-input"]').inputValue();
  h.check('checkpoint is repeatable (restore works a second time)', shapeVal === '48', `got "${shapeVal}"`);

  // ─── Part 2: shareable state URL ────────────────────────────────────────
  // State is currently shape=48 (from the restore above).

  await page.locator('[data-testid="share-state"]').click();
  await page.waitForTimeout(200);

  const shareLabel = await page.locator('[data-testid="share-state"]').innerText();
  h.check('share-state button shows a copied confirmation', /Copied/.test(shareLabel), `label="${shareLabel}"`);

  let copiedUrl = await page.evaluate(() => window.__copiedText);
  if (!copiedUrl) {
    // Fall back to the real clipboard if the stub somehow wasn't hit.
    copiedUrl = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  }
  h.check('a URL was copied to the clipboard', typeof copiedUrl === 'string' && copiedUrl.includes('#s='), `copiedUrl=${String(copiedUrl).slice(0, 80)}...`);

  await shot(page, 'share-checkpoint-shared');

  // Open a NEW page at that URL and verify state matches, hash stripped.
  const page2 = await ctx.newPage();
  await page2.goto(copiedUrl, { waitUntil: 'load' });
  await page2.waitForTimeout(1000);

  const shape2 = await page2.locator('[data-testid="shape-input"]').inputValue();
  h.check('new page loaded from the share URL shows shape 48', shape2 === '48', `got "${shape2}"`);

  const hashAfterLoad = await page2.evaluate(() => location.hash);
  h.check('the #s= hash is stripped from the URL after load', hashAfterLoad === '', `hash="${hashAfterLoad}"`);

  await shot(page2, 'share-checkpoint-new-page');

  await page2.close();
  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
