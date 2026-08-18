// Regression scenario: linearization + byte order (codec-curation Tasks cl-6
// through cl-10).
//
// Covers the two Chunk-section controls added by the codec-curation project
// and the endianness metadata lesson:
//   (a) the linearization select is hidden for tabular (and 1-D), visible for
//       a 2-D array, defaulting to C order; the byte-order select is visible
//       for BOTH models (any multi-byte dtype has an endianness).
//   (b) switching C -> Morton changes the Linearized stage's BYTES but not
//       its byte COUNT (same elements, different order), and Read still
//       round-trips. This is also the regression pin for the
//       useWorkerPipeline dependency-allowlist bug (linearization/byteOrder
//       missing from the compute-trigger list -> stale panes), found and
//       fixed during Task cl-10.
//   (c) byte-order big with "Include Endianness" ON -> read succeeds.
//   (d) byte-order big with "Include Endianness" OFF -> read still reports
//       success (the silent-corruption lesson: no failure, no warning), but
//       the Read process view's decode-chunks step narrates the guess
//       ("assuming host") and the reconstructed values actually differ from
//       the source values.
//   (e) zero pageerrors across the whole session.
//
// Run: node tests/ui/scenario-linearization-endianness.mjs   (dev server must be running)

import { launch, shot, createHarness, seedStateAndReload, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-linearization-endianness');

const ARRAY_KEY = '0x00c0dec5-state-array';

async function readStatusText(page) {
  return page.locator('[data-testid="read-status"]').innerText().catch(() => '');
}

/** Parse the pipeline strip's Linearized-stage byte count (stage index 2 —
 * same fixed indices and regex parsing as scenario-talk-arc's stageStats). */
async function linearizedByteCount(page) {
  const text = await page.locator('[data-testid="pipeline-stage-2"]').innerText();
  const m = text.match(/([\d.]+)\s*(B|KB|MB|GB)\b/);
  return m ? `${m[1]} ${m[2]}` : '(unparsed)';
}

async function leftPaneHexText(page) {
  return page.locator('[data-testid="pane-left"] [data-testid="hex-view"]').first().innerText();
}

async function main() {
  const { browser, page, issues } = await launch({ fresh: true });
  await waitForPipelineIdle(page);

  // ─── (a) control visibility: tabular ────────────────────────────────────
  await page.locator('[data-testid="sidebar-section-chunk"]').scrollIntoViewIfNeeded();
  h.check(
    '(a) tabular: linearization select is hidden',
    (await page.locator('[data-testid="linearization-select"]').count()) === 0,
  );
  h.check(
    '(a) tabular: byte-order select is visible (both models get one)',
    (await page.locator('[data-testid="byte-order-toggle"]').count()) === 1,
  );

  // ─── (a) control visibility: 2-D array ──────────────────────────────────
  // Seed a small 2-D array state (metadata on, so Read has something to
  // parse) rather than clicking "+ Dim" — house convention for pre-seeded
  // states (CLAUDE.md pitfall 7).
  await page.locator('[data-testid="model-toggle-array"]').click();
  await page.waitForTimeout(500);
  await seedStateAndReload(page, {
    [ARRAY_KEY]: {
      dataModel: 'array',
      shape: [8, 8],
      chunkShape: [4, 4],
      metadata: {
        enabled: true,
        include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true },
      },
    },
  });
  await waitForPipelineIdle(page);

  await page.locator('[data-testid="sidebar-section-chunk"]').scrollIntoViewIfNeeded();
  h.check(
    '(a) 2-D array: linearization select is visible',
    (await page.locator('[data-testid="linearization-select"]').count()) === 1,
  );
  const linDefault = await page.locator('[data-testid="linearization-select"]').inputValue().catch(() => '(missing)');
  h.check('(a) 2-D array: linearization defaults to C order', linDefault === 'c', `value="${linDefault}"`);
  await shot(page, 'lin-endian-a');

  // ─── (b) C -> Morton: same byte count, different bytes, Read round-trips ─
  await page.locator('[data-testid="pane-dropdown-left"]').selectOption('linearized');
  await page.waitForTimeout(300);
  await page.locator('[data-testid="pane-left"] [data-testid="view-mode-hex"]').click();
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page);

  const countBefore = await linearizedByteCount(page);
  const hexBefore = await leftPaneHexText(page);

  await page.locator('[data-testid="linearization-select"]').selectOption('morton');
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);

  const countAfter = await linearizedByteCount(page);
  const hexAfter = await leftPaneHexText(page);

  h.check(
    '(b) C -> Morton: Linearized byte count is unchanged (same elements, different order)',
    countBefore === countAfter && countBefore !== '(unparsed)',
    `before=${countBefore} after=${countAfter}`,
  );
  h.check(
    '(b) C -> Morton: Linearized hex bytes DIFFER (the permutation is real and the pane recomputed)',
    hexBefore !== hexAfter,
    `hex text ${hexBefore === hexAfter ? 'identical — stale pane or identity permutation' : 'differs'}`,
  );
  const readAfterMorton = await readStatusText(page);
  h.check(
    '(b) Read still round-trips under Morton order',
    /File parsed successfully/.test(readAfterMorton),
    readAfterMorton.slice(0, 120).replace(/\n/g, ' '),
  );
  await shot(page, 'lin-endian-b');

  // ─── (c) byte-order big + endianness include ON -> read succeeds ────────
  await page.locator('[data-testid="byte-order-toggle"]').selectOption('big');
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);

  const hexBig = await leftPaneHexText(page);
  h.check(
    '(c) big-endian: Linearized hex bytes differ from little-endian (byteOrder recompute is live)',
    hexBig !== hexAfter,
    `hex text ${hexBig === hexAfter ? 'identical — stale pane' : 'differs'}`,
  );
  const readBigEndian = await readStatusText(page);
  h.check(
    '(c) big-endian + Include Endianness ON: read succeeds',
    /File parsed successfully/.test(readBigEndian),
    readBigEndian.slice(0, 120).replace(/\n/g, ' '),
  );
  await shot(page, 'lin-endian-c');

  // ─── (d) byte-order big + endianness include OFF -> silent corruption ───
  await page.locator('[data-testid="sidebar-section-metadata"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="include-endianness-toggle"] button', { hasText: /^No$/ }).click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);

  const readNoEndian = await readStatusText(page);
  h.check(
    '(d) big-endian + Include Endianness OFF: read STILL reports success (silent, not a failure)',
    /File parsed successfully/.test(readNoEndian) && !/Read failed/.test(readNoEndian),
    readNoEndian.slice(0, 120).replace(/\n/g, ' '),
  );

  // The decode-chunks step narrates the guess.
  await page.locator('[data-testid="pane-dropdown-right"]').selectOption('read');
  await page.waitForTimeout(300);
  await page.locator('[data-testid="pane-right"] [data-testid="view-mode-process"]').click();
  await page.waitForTimeout(300);
  const decodeStepText = await page
    .locator('[data-testid="pane-right"] [data-testid="read-step-decode-chunks"]')
    .innerText()
    .catch(() => '(missing)');
  h.check(
    '(d) decode-chunks step detail narrates the assumption ("assuming host")',
    /assuming host/.test(decodeStepText),
    decodeStepText.slice(0, 160).replace(/\n/g, ' '),
  );

  // ...and the reconstructed values are actually wrong: compare table cells
  // between the Values stage (left pane) and the Read stage (right pane).
  await page.locator('[data-testid="pane-dropdown-left"]').selectOption('values');
  await page.waitForTimeout(200);
  await page.locator('[data-testid="pane-left"] [data-testid="view-mode-table"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-testid="pane-right"] [data-testid="view-mode-table"]').click();
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page);

  let mismatches = 0;
  let compared = 0;
  for (let i = 0; i < 8; i++) {
    const left = await page
      .locator(`[data-testid="pane-left"] [data-testid="table-cell-temperature-${i}"]`)
      .innerText()
      .catch(() => null);
    const right = await page
      .locator(`[data-testid="pane-right"] [data-testid="table-cell-temperature-${i}"]`)
      .innerText()
      .catch(() => null);
    if (left !== null && right !== null) {
      compared++;
      if (left !== right) mismatches++;
    }
  }
  h.check(
    '(d) Read-stage table values DIFFER from Values-stage (the corruption is real)',
    compared > 0 && mismatches > 0,
    `compared=${compared} mismatches=${mismatches}`,
  );
  await shot(page, 'lin-endian-d');

  // ─── (e) zero pageerrors across the whole session ────────────────────────
  h.check(
    '(e) zero pageerrors across the whole session',
    issues.pageerror.length === 0,
    issues.pageerror.slice(0, 5).join(' | '),
  );

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
