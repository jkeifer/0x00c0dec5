// Regression scenario: project 4 (real codecs via Pyodide/numcodecs).
//
// Run 1 (online): the runtime banner narrates the load and disappears; real
// codecs go disabled -> enabled in the picker; adding Zstd to a variable
// pipeline shrinks the Encoded stage and the Read stage still round-trips.
// Run 2 (CDN blocked): the banner becomes a dismissible error; educational
// codecs still work.
//
// Needs network on a cold browser profile (downloads ~30MB from
// cdn.jsdelivr.net on run 1). Run: node tests/ui/scenario-real-codecs.mjs
// (dev server must be running).

import { chromium } from 'playwright';
import { newContext, shot, createHarness, seedStateAndReload, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-real-codecs');

// Column-interleaved tabular state with one small numeric variable — small
// shape so computes are instant and the codec effect is unambiguous.
function baseState() {
  return {
    dataModel: 'array',
    shape: [64, 64],
    chunkShape: [64, 64],
    interleaving: 'column',
    variables: [
      { id: 'temp', name: 'temp', color: '#e06c75',
        logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
        typeAssignment: { storageDtype: 'float32' } },
    ],
    fieldPipelines: { temp: [] },
    chunkPipeline: [],
    metadata: { customEntries: [], serialization: 'json', include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true } },
    write: { includeMetadata: true, magicNumber: '00C0DEC5', partitioning: 'single', metadataPlacement: 'header', chunkOrder: 'row-major', footerLocator: 'trailer' },
    ui: { leftPaneStage: 'encoded', rightPaneStage: 'read', leftPaneView: 'hex', rightPaneView: 'table', showDiff: false },
  };
}

// engine/bytes.ts formatByteCount: "N B" (<1024), "N.N KB" (<1MB), "N.N MB"
// otherwise — three tiers, space before unit. Parse back to a byte count so
// comparisons are unit-aware (a naive /\d+\s*B/ regex misparses "16.0 KB" by
// grabbing the trailing "0 KB" as if it were bytes).
function parseByteCount(text) {
  const m = text.match(/([\d.]+)\s*(B|KB|MB)\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2] === 'MB' ? 1024 * 1024 : m[2] === 'KB' ? 1024 : 1;
  return n * mult;
}

async function encodedByteCount(page) {
  // Pipeline strip stage node (index 3 = "Encoded"; order is
  // Values/Typed/Linearized/Encoded/Metadata/Write/Read) shows the stage's
  // byte count alongside its entropy.
  const text = await page.locator('[data-testid="pipeline-stage-3"]').innerText();
  return parseByteCount(text);
}

async function main() {
  const browser = await chromium.launch();

  // ── Run 1: online — load narration, picker enablement, zstd round-trip ──
  {
    const { ctx, page, issues } = await newContext(browser);
    await seedStateAndReload(page, {
      '0x00c0dec5-active-model': 'array',
      '0x00c0dec5-state-array': baseState(),
    });

    const banner = page.locator('[data-testid="runtime-banner"]');
    // The banner unmounts entirely once the runtime is ready (RuntimeBanner.tsx
    // returns null), so it may already be gone by the time we attach on a fast
    // (warm-cache) load. Tolerate either path, but require the end state
    // (ready picker) either way.
    const bannerAppeared = await banner.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
    if (bannerAppeared) {
      console.log('[info] run 1 took the SLOW path: banner observed while loading');
      const bannerGone = await banner.waitFor({ state: 'detached', timeout: 180_000 }).then(() => true).catch(() => false);
      h.check('runtime banner disappears when the runtime is ready', bannerGone);
    } else {
      console.log('[info] run 1 took the FAST path: runtime was already ready (or banner never observed) by first attach');
    }

    await waitForPipelineIdle(page, 60_000);

    const zstdOption = page.locator('option[value="zstd"]').first();
    const zstdReady = await zstdOption.isEnabled({ timeout: 180_000 }).catch(() => false);
    h.check(
      'runtime banner appears while loading OR runtime is already ready (zstd enabled) by first attach',
      bannerAppeared || zstdReady,
      `bannerAppeared=${bannerAppeared} zstdReady=${zstdReady}`,
    );
    h.check('zstd option is enabled once ready', zstdReady);

    const before = await encodedByteCount(page);
    // Add Zstd to temp's pipeline via the sidebar picker.
    const select = page.locator('[data-testid="sidebar-section-codecs"] select').last();
    await select.selectOption('zstd');
    await waitForPipelineIdle(page, 60_000);
    const after = await encodedByteCount(page);
    h.check(
      'adding real zstd shrinks the Encoded stage',
      before !== null && after !== null && after < before,
      `before=${before} after=${after}`,
    );

    const readStatus = await page.locator('[data-testid="read-status"]').innerText();
    h.check('Read still round-trips with zstd in the pipeline', /file parsed successfully/i.test(readStatus) && !/read failed/i.test(readStatus), readStatus);

    h.check('no page errors in run 1', issues.pageerror.length === 0, issues.pageerror.slice(0, 3).join(' | '));
    await shot(page, 'real-codecs-online');
    await ctx.close();
  }

  // ── Run 2: CDN blocked — honest failure, educational codecs unaffected ──
  {
    const { ctx, page, issues } = await newContext(browser);
    await ctx.route('**://cdn.jsdelivr.net/**', (route) => route.abort());
    await seedStateAndReload(page, {
      '0x00c0dec5-active-model': 'array',
      '0x00c0dec5-state-array': baseState(),
    });

    // The banner is visible in BOTH the loading state ("Loading real
    // codecs:…") and the error state ("Real codecs unavailable: …") — wait
    // for the error text specifically rather than just first-visible, which
    // can catch it mid-load.
    const banner = page.locator('[data-testid="runtime-banner"]');
    const dismissBtn = page.locator('[data-testid="runtime-banner-dismiss"]');
    await dismissBtn.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
    const text = (await banner.innerText().catch(() => '')) || '';
    h.check('CDN failure shows the error banner', text.includes('Real codecs unavailable'), text);

    await waitForPipelineIdle(page, 60_000);
    const select = page.locator('[data-testid="sidebar-section-codecs"] select').last();
    await select.selectOption('delta');
    await waitForPipelineIdle(page, 60_000);
    const readStatus = await page.locator('[data-testid="read-status"]').innerText();
    h.check('educational codecs still work with the runtime failed', /file parsed successfully/i.test(readStatus) && !/read failed/i.test(readStatus), readStatus);

    h.check('no page errors in run 2', issues.pageerror.length === 0, issues.pageerror.slice(0, 3).join(' | '));
    await shot(page, 'real-codecs-offline');
    await ctx.close();
  }

  await browser.close();
  h.finish();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
