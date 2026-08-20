// Regression scenario: codec-unification Task 11 — transform codecs
// (quantize, scale-offset) as ordinary pipeline steps, and row-mode's
// per-variable prefix editors.
//
// Seeds a column-mode array state with one float32 variable whose field
// pipeline is [quantize(digits:1), scale-offset(scale:10, offset:0,
// sourceDtype:'float32', targetDtype:'int16')] — both codecs are
// element-structured (no traceMode, not variable-size), so the whole
// pipeline stays active when interleaving switches to row.
//
// Run: node tests/ui/scenario-transform-codecs.mjs (dev server must be running).

import { chromium } from 'playwright';
import { newContext, createHarness, seedStateAndReload, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-transform-codecs');

function baseState() {
  return {
    dataModel: 'array',
    shape: [32, 32],
    chunkShape: [32, 32],
    interleaving: 'column',
    variables: [
      {
        id: 'temp',
        name: 'temp',
        color: '#e06c75',
        logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
        typeAssignment: { storageDtype: 'float32' },
      },
    ],
    fieldPipelines: {
      temp: [
        { codec: 'quantize', params: { digits: 1 } },
        {
          codec: 'scale-offset',
          params: { scale: 10, offset: 0, sourceDtype: 'float32', targetDtype: 'int16' },
        },
      ],
    },
    chunkPipeline: [],
    metadata: {
      enabled: true,
      customEntries: [],
      serialization: 'json',
      include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
    },
    write: { magicNumber: '00C0DEC5', partitioning: 'single', metadataPlacement: 'header', chunkOrder: 'row-major', footerLocator: 'trailer' },
    ui: { leftPaneStage: 'encoded', rightPaneStage: 'read', leftPaneView: 'hex', rightPaneView: 'table' },
  };
}

async function main() {
  const browser = await chromium.launch();
  const { ctx, page, issues } = await newContext(browser);

  await seedStateAndReload(page, {
    '0x00c0dec5-active-model': 'array',
    '0x00c0dec5-state-array': baseState(),
  });
  await waitForPipelineIdle(page, 30_000);

  // Column mode: both steps render on the per-variable editor.
  const step0 = page.locator('[data-testid="codec-step-temp-0"]');
  const step1 = page.locator('[data-testid="codec-step-temp-1"]');
  h.check('quantize step (codec-step-temp-0) renders', await step0.count() === 1);
  h.check('scale-offset step (codec-step-temp-1) renders', await step1.count() === 1);

  const readStatus = await page.locator('[data-testid="read-status"]').innerText();
  h.check(
    'Read round-trips successfully with the transform pipeline',
    /file parsed successfully/i.test(readStatus) && !/read failed/i.test(readStatus),
    readStatus,
  );

  // scale-offset is lossy (quantize rounds, scale/offset rounds+clips) — the
  // worker-computed stats badge should show up on step 1.
  const lossyBadge = page.locator('[data-testid="codec-lossy-temp-1"]');
  h.check('scale-offset lossy badge (codec-lossy-temp-1) appears', await lossyBadge.count() === 1);

  // Switch interleaving to row via the UI.
  const interleaveSection = page.locator('[data-testid="sidebar-section-interleave"]');
  await interleaveSection.getByText('Band-interleaved (BIP)').click();
  await waitForPipelineIdle(page, 30_000);

  // Both codecs are element-structured (no traceMode, fixed dtype/ratio), so
  // the whole 2-step field pipeline stays active in row mode: no inactive
  // note, and both steps still render on the per-variable editor.
  const rowStep0 = page.locator('[data-testid="codec-step-temp-0"]');
  const rowStep1 = page.locator('[data-testid="codec-step-temp-1"]');
  h.check('per-variable editor step 0 still renders in row mode', await rowStep0.count() === 1);
  h.check('per-variable editor step 1 still renders in row mode', await rowStep1.count() === 1);

  const inactiveNote = page.locator('[data-testid="codec-row-inactive-note-temp"]');
  h.check(
    'no inactive note — both quantize and scale-offset are structured (inactiveFrom === steps.length)',
    await inactiveNote.count() === 0,
  );

  const step0Opacity = await rowStep0.evaluate((el) => el.style.opacity);
  const step1Opacity = await rowStep1.evaluate((el) => el.style.opacity);
  h.check(
    'both steps render at full opacity in row mode',
    step0Opacity === '1' && step1Opacity === '1',
    `step0=${step0Opacity} step1=${step1Opacity}`,
  );

  h.check('left pane still renders', await page.locator('[data-testid="pane-left"]').count() === 1);
  h.check('right pane still renders', await page.locator('[data-testid="pane-right"]').count() === 1);

  h.check('no page errors', issues.pageerror.length === 0, issues.pageerror.slice(0, 3).join(' | '));

  await ctx.close();
  await browser.close();
  h.finish();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
