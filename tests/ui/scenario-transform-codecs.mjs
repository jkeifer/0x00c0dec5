// Regression scenario: codec-unification Task 11 — transform codecs
// (quantize, scale-offset) as ordinary pipeline steps — plus row/column
// interleaving's single-shared-pipeline contract.
//
// Seeds a column-mode array state with one float32 variable whose field
// pipeline is [quantize(digits:1), scale-offset(scale:10, offset:0,
// sourceDtype:'float32', targetDtype:'int16')]. Switching to row mode runs
// NO per-variable field pipelines — variables are cast to their storage
// dtype, interleaved at raw widths, and only the shared chunk pipeline runs;
// switching back to column restores the field pipeline untouched from state.
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

  // Row mode runs no per-variable field pipelines at all: the per-variable
  // editor and its add-codec control are gone, only the shared chunk editor
  // remains, and the old "inactive remainder" note doesn't exist anymore.
  h.check(
    'per-variable add-codec control (codec-add-temp) is gone in row mode',
    await page.locator('[data-testid="codec-add-temp"]').count() === 0,
  );
  h.check(
    'shared chunk add-codec control (codec-add-chunk) renders in row mode',
    await page.locator('[data-testid="codec-add-chunk"]').count() === 1,
  );
  h.check(
    'per-variable step (codec-step-temp-0) is gone in row mode',
    await page.locator('[data-testid="codec-step-temp-0"]').count() === 0,
  );
  h.check(
    'no inactive-remainder note anywhere in row mode',
    await page.locator('[data-testid^="codec-row-inactive-note-"]').count() === 0,
  );

  h.check('left pane still renders', await page.locator('[data-testid="pane-left"]').count() === 1);
  h.check('right pane still renders', await page.locator('[data-testid="pane-right"]').count() === 1);

  // Switch back to Column-oriented: the seeded field pipeline (untouched in
  // state while row mode was active) re-renders intact, same codec labels.
  await interleaveSection.getByText('Band-sequential (BSQ)').click();
  await waitForPipelineIdle(page, 30_000);

  const restoredStep0 = page.locator('[data-testid="codec-step-temp-0"]');
  const restoredStep1 = page.locator('[data-testid="codec-step-temp-1"]');
  h.check('field pipeline step 0 (temp-0) restored on switch back to column', await restoredStep0.count() === 1);
  h.check('field pipeline step 1 (temp-1) restored on switch back to column', await restoredStep1.count() === 1);
  h.check(
    'restored step 0 is still Quantize',
    (await restoredStep0.innerText()).includes('Quantize'),
  );
  h.check(
    'restored step 1 is still Scale/Offset',
    (await restoredStep1.innerText()).includes('Scale/Offset'),
  );

  h.check('no page errors', issues.pageerror.length === 0, issues.pageerror.slice(0, 3).join(' | '));

  await ctx.close();
  await browser.close();
  h.finish();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
