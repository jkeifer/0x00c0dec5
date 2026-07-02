// Regression scenario: crash-input hardening from Phase 0 of docs/remediation-plan.md.
//
// Ports the checks from tests/ui/verify-phase0.mjs onto the shared scenario harness.
// All checks here are expected to PASS — Phase 0 ("Stop the crashes") has landed
// per the remediation plan's checklist (0.1-0.6 all checked off). There are no
// KNOWN-FAIL entries in this file; if one of these regresses, that's a real bug.
//
// Run: node tests/ui/scenario-crash-inputs.mjs   (dev server must be running)

import { chromium } from 'playwright';
import { newContext, shot, bodyRendered, boundaryShown, createHarness, safeReload, seedStateAndReload } from './scenario-helpers.mjs';

const h = createHarness('scenario-crash-inputs');

// Both panes are present and showing real content (not blank/errored). This
// used to count occurrences of the "Table" view-mode label across the page,
// on the assumption both panes default to a Table-capable stage — that
// assumption broke (correctly) when Phase 3.8/4.1 fixed SW-2: the right pane
// now genuinely defaults to the Write stage, whose only view mode is Hex, so
// "Table" appears just once (left pane) on a healthy fresh load. Checking
// each pane container directly for non-empty content is robust to which
// stage/view each pane happens to default to.
async function bothPanesRender(page) {
  const leftText = await page.locator('[data-testid="pane-left"]').innerText().catch(() => '');
  const rightText = await page.locator('[data-testid="pane-right"]').innerText().catch(() => '');
  return leftText.trim().length > 0 && rightText.trim().length > 0;
}

async function main() {
  const browser = await chromium.launch();

  // ── Magic-number garbage typing: "ZZZ" then a lone "0" ──────────────────
  {
    const { page, issues } = await newContext(browser);
    const magicInput = page.locator('[data-testid="magic-input"]');
    await magicInput.waitFor({ state: 'visible', timeout: 5000 });

    await magicInput.fill('');
    await page.keyboard.type('ZZZ');
    await page.waitForTimeout(400);
    await shot(page, 'crash-inputs-magic-zzz');
    const blankAfterZZZ = !(await bodyRendered(page));
    const boundaryAfterZZZ = await boundaryShown(page);
    const bothPanesZZZ = await bothPanesRender(page);
    const warningTextZZZ = (await page.locator('text=Invalid hex').count()) > 0;

    await magicInput.fill('');
    await page.keyboard.type('0');
    await page.waitForTimeout(400);
    await shot(page, 'crash-inputs-magic-single-zero');
    const blankAfterZero = !(await bodyRendered(page));
    const boundaryAfterZero = await boundaryShown(page);
    const bothPanesZero = await bothPanesRender(page);
    const warningTextZero = (await page.locator('text=Invalid hex').count()) > 0;

    h.check(
      'magic field "ZZZ" does not blank/crash the app and shows invalid-hex warning',
      !blankAfterZZZ && !boundaryAfterZZZ && bothPanesZZZ && warningTextZZZ,
      `blank=${blankAfterZZZ} boundary=${boundaryAfterZZZ} bothPanes=${bothPanesZZZ} warn=${warningTextZZZ}`,
    );
    h.check(
      'magic field lone "0" does not blank/crash the app and shows invalid-hex warning',
      !blankAfterZero && !boundaryAfterZero && bothPanesZero && warningTextZero,
      `blank=${blankAfterZero} boundary=${boundaryAfterZero} bothPanes=${bothPanesZero} warn=${warningTextZero}`,
    );
    h.check(
      'no page errors thrown while typing garbage magic input',
      issues.pageerror.length === 0,
      `pageerrors=${issues.pageerror.length}`,
    );
    await page.context().close();
  }

  // ── Legacy v1 localStorage seed (pre-migration shape) ────────────────────
  {
    const { page, issues } = await newContext(browser, { fresh: true });
    const v1State = {
      variables: [{ id: 'a', name: 'a', dtype: 'float32', color: '#e06c75' }],
      shape: [32],
      chunkShape: [32],
      interleaving: 'column',
      fieldPipelines: {
        a: [
          { codec: 'scale-offset', params: {} },
          { codec: 'delta', params: { order: 1 } },
        ],
      },
      chunkPipeline: [],
      metadata: { customEntries: [], serialization: 'json' },
      write: {
        magicNumber: '00C0DEC5',
        partitioning: 'single',
        metadataPlacement: 'header',
        chunkOrder: 'row-major',
      },
    };
    await seedStateAndReload(page, { '0x00c0dec5-state-tabular': v1State });
    await page.waitForTimeout(1200);
    await shot(page, 'crash-inputs-legacy-v1');

    const rendered = await bodyRendered(page);
    const boundary = await boundaryShown(page);
    const varAVisible = (await page.locator('input[placeholder="name"][value="a"]').count()) > 0;
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const hasDelta = /Delta/.test(bodyText);
    const hasScaleOffset = /scale-offset|Scale.?Offset/i.test(bodyText);

    h.check(
      'legacy v1 localStorage state migrates without crashing',
      rendered && !boundary,
      `rendered=${rendered} boundary=${boundary} pageerrors=${issues.pageerror.length}`,
    );
    h.check(
      'legacy variable "a" survives migration',
      varAVisible,
      `varAVisible=${varAVisible}`,
    );
    h.check(
      'legacy scale-offset codec migrated away (no longer a codec, folded into Type Assignment)',
      hasDelta && !hasScaleOffset,
      `hasDelta=${hasDelta} hasScaleOffset=${hasScaleOffset}`,
    );
    await page.context().close();
  }

  // ── Corrupt state seeds: garbage fields, then invalid JSON ──────────────
  {
    const { page, issues } = await newContext(browser, { fresh: true });
    await seedStateAndReload(page, {
      '0x00c0dec5-state-tabular': { variables: 'garbage', shape: [0, -1] },
    });
    await page.waitForTimeout(1200);
    await shot(page, 'crash-inputs-garbage-fields');
    const rendered1 = await bodyRendered(page);
    const boundary1 = await boundaryShown(page);
    const bodyText1 = await page.locator('body').innerText().catch(() => '');
    const starterVars1 = ['temperature', 'pressure', 'humidity'].every((n) => bodyText1.includes(n));

    h.check(
      'corrupt state (garbage variables/shape) falls back to defaults without crashing',
      rendered1 && !boundary1 && starterVars1,
      `rendered=${rendered1} boundary=${boundary1} starters=${starterVars1}`,
    );

    issues.console.length = 0;
    issues.pageerror.length = 0;
    await seedStateAndReload(page, {
      '0x00c0dec5-state-tabular': 'not json at all{{{',
    });
    await page.waitForTimeout(1200);
    await shot(page, 'crash-inputs-not-json');
    const rendered2 = await bodyRendered(page);
    const boundary2 = await boundaryShown(page);
    const bodyText2 = await page.locator('body').innerText().catch(() => '');
    const starterVars2 = ['temperature', 'pressure', 'humidity'].every((n) => bodyText2.includes(n));

    h.check(
      'invalid JSON in localStorage falls back to defaults without crashing',
      rendered2 && !boundary2 && starterVars2,
      `rendered=${rendered2} boundary=${boundary2} starters=${starterVars2}`,
    );
    await page.context().close();
  }

  // ── chunkShape [0] seed ───────────────────────────────────────────────────
  {
    const { page, issues } = await newContext(browser, { fresh: true });
    const zeroChunkState = {
      dataModel: 'tabular',
      variables: [
        {
          id: 'a',
          name: 'temperature',
          color: '#e06c75',
          logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 },
          typeAssignment: { storageDtype: 'float32' },
        },
      ],
      shape: [32],
      chunkShape: [0],
      interleaving: 'column',
      fieldPipelines: {},
      chunkPipeline: [],
      metadata: { customEntries: [], serialization: 'json' },
      write: {
        magicNumber: '00C0DEC5',
        partitioning: 'single',
        metadataPlacement: 'header',
        chunkOrder: 'row-major',
        includeMetadata: true,
      },
      ui: {},
    };
    await page.context().addInitScript((s) => {
      localStorage.setItem('0x00c0dec5-state-tabular', JSON.stringify(s));
    }, zeroChunkState);

    let navErr = null;
    try {
      await page.goto('http://localhost:5173/0x00c0dec5/', { timeout: 10000 });
      await safeReload(page, { timeout: 10000 });
    } catch (e) {
      navErr = e.message;
    }
    await page.waitForTimeout(1000);
    await shot(page, 'crash-inputs-chunkshape-zero');

    const rendered = await bodyRendered(page);
    const boundary = await boundaryShown(page);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const chunkGridMatch = bodyText.match(/Grid:\s*(\d+)/);
    const chunkClamped = chunkGridMatch ? Number(chunkGridMatch[1]) > 0 : false;

    h.check(
      'chunkShape [0] seed does not hang navigation and clamps to a valid (nonzero) grid',
      navErr === null && rendered && !boundary && chunkClamped,
      `navErr=${navErr} rendered=${rendered} boundary=${boundary} chunkGridMatch=${chunkGridMatch ? chunkGridMatch[0] : 'none'}`,
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
