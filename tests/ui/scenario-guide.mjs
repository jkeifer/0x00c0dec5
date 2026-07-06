// Regression scenario: Guide panel + presenter mode (plan Phase 5).
//
// Covers:
//  - fresh load: no guide panel; header guide-toggle opens it on the intro
//    step with no sidebar section highlighted;
//  - stepping through all 10 steps highlights each sectioned step's sidebar
//    section (data-guide-active + computed outline, section in view);
//  - collapse to the 48px presenter rail — guide-next still advances;
//  - close via expand + guide-close removes the panel;
//  - seeded ui-prefs {guideOpen:true, guideStep:4} resumes on step 5/10;
//  - `?presenter` starts the panel open but collapsed to the rail.
//
// Run: node tests/ui/scenario-guide.mjs   (dev server must be running)

import { chromium } from 'playwright';
import { BASE_URL, newContext, seedStateAndReload, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-guide');

// Must mirror src/components/guide/steps.ts (section slug per step, in order).
const STEP_SECTIONS = [
  null, 'schema', 'chunk', 'interleave', 'typing', 'codecs', 'metadata', 'write', 'read', null,
];

async function main() {
  const browser = await chromium.launch();

  // ── Open, step through, collapse, close ───────────────────────────────────
  {
    const { page, issues } = await newContext(browser, { fresh: true });

    h.check(
      'fresh load: guide panel not present',
      (await page.locator('[data-testid="guide-panel"]').count()) === 0,
    );

    await page.locator('[data-testid="guide-toggle"]').click();
    await page.waitForTimeout(200);
    const panel = page.locator('[data-testid="guide-panel"]');
    h.check('guide-toggle opens the panel', await panel.isVisible());
    h.check(
      'intro step content shown (1/10 + Try it callout)',
      /1\/10/.test(await panel.innerText()) && /Try it/i.test(await panel.innerText()),
    );
    h.check(
      'intro step highlights no sidebar section',
      (await page.locator('[data-guide-active]').count()) === 0,
    );
    await shot(page, 'guide-expanded');

    // Step through all 10 steps, checking the highlight at each.
    let allHighlighted = true;
    let allInView = true;
    let detail = '';
    for (let i = 1; i < STEP_SECTIONS.length; i++) {
      await page.locator('[data-testid="guide-next"]').click();
      await page.waitForTimeout(400); // allow smooth scrollIntoView to settle
      const section = STEP_SECTIONS[i];
      if (section === null) {
        if ((await page.locator('[data-guide-active]').count()) !== 0) {
          allHighlighted = false;
          detail += ` step ${i}: expected no highlight;`;
        }
        continue;
      }
      const el = page.locator(`[data-testid="sidebar-section-${section}"][data-guide-active]`);
      if ((await el.count()) !== 1) {
        allHighlighted = false;
        detail += ` step ${i}: ${section} not marked active;`;
        continue;
      }
      const outline = await el.evaluate((n) => getComputedStyle(n).outlineStyle);
      if (outline !== 'solid') {
        allHighlighted = false;
        detail += ` step ${i}: ${section} outline=${outline};`;
      }
      const box = await el.boundingBox();
      const viewport = page.viewportSize();
      if (!box || box.y + box.height < 0 || box.y > viewport.height) {
        allInView = false;
        detail += ` step ${i}: ${section} out of view (y=${box?.y});`;
      }
    }
    h.check('each sectioned step marks its sidebar section active with a solid outline', allHighlighted, detail);
    h.check('each highlighted section is scrolled into the viewport', allInView, detail);
    h.check(
      'panel shows 10/10 and Next is disabled at the last step',
      /10\/10/.test(await panel.innerText()) &&
        (await page.locator('[data-testid="guide-next"]').isDisabled()),
    );

    // Collapse to the presenter rail; navigation must still work.
    await page.locator('[data-testid="guide-collapse"]').click();
    await page.waitForTimeout(200);
    const railBox = await panel.boundingBox();
    h.check(
      'guide-collapse shrinks the panel to a <60px rail',
      railBox !== null && railBox.width < 60,
      `width=${railBox?.width}`,
    );
    await page.locator('[data-testid="guide-back"]').click(); // 10 -> 9 (enables next)
    await page.waitForTimeout(200);
    await page.locator('[data-testid="guide-next"]').click(); // 9 -> 10
    await page.waitForTimeout(200);
    h.check(
      'rail back/next still drive the flow (back to 9, next to 10/10)',
      /10\/10/.test(await panel.innerText()),
      await panel.innerText(),
    );
    await shot(page, 'guide-rail');

    // Expand, then close.
    await page.locator('[data-testid="guide-expand"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="guide-close"]').click();
    await page.waitForTimeout(200);
    h.check(
      'guide-close removes the panel',
      (await page.locator('[data-testid="guide-panel"]').count()) === 0,
    );

    h.check(
      'no console errors or page errors while driving the guide',
      issues.pageerror.length === 0 &&
        issues.console.filter((m) => m.startsWith('[console.error]')).length === 0,
      [...issues.pageerror, ...issues.console].join(' | '),
    );
    await page.context().close();
  }

  // ── Seeded ui-prefs resume ─────────────────────────────────────────────────
  {
    const { page, issues } = await newContext(browser, { fresh: true });
    await seedStateAndReload(page, {
      '0x00c0dec5-ui-prefs': JSON.stringify({ guideOpen: true, guideStep: 4 }),
    });
    await page.waitForTimeout(500);
    const panel = page.locator('[data-testid="guide-panel"]');
    h.check('seeded {guideOpen:true, guideStep:4} opens the panel', await panel.isVisible());
    h.check(
      'seeded guide resumes on step 5/10',
      /5\/10/.test(await panel.innerText()),
      await panel.innerText(),
    );
    h.check(
      "step 5 highlights the 'typing' sidebar section",
      (await page.locator('[data-testid="sidebar-section-typing"][data-guide-active]').count()) === 1,
    );
    h.check(
      'no page errors on seeded resume',
      issues.pageerror.length === 0,
      issues.pageerror.join(' | '),
    );
    await page.context().close();
  }

  // ── ?presenter starts collapsed ────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    const page = await ctx.newPage();
    const pageerrors = [];
    page.on('pageerror', (e) => pageerrors.push(e.message));
    await page.goto(`${BASE_URL}?presenter`, { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    const panel = page.locator('[data-testid="guide-panel"]');
    const box = await panel.boundingBox();
    h.check('?presenter shows the guide panel', await panel.isVisible());
    h.check(
      '?presenter starts collapsed to the rail',
      box !== null && box.width < 60 &&
        (await page.locator('[data-testid="guide-expand"]').count()) === 1,
      `width=${box?.width}`,
    );
    h.check('no page errors under ?presenter', pageerrors.length === 0, pageerrors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  h.finish();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
