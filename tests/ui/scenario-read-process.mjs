// Regression scenario: read-process view + granular metadata toggles
// (read plan Tasks 1-6; this file is Task 7; ladder walk + per-chunk/entropy
// end-to-end check added by the metadata redesign's Task 14).
//
// Covers the reader's narrated 8-step log (READ_STEP_ORDER in
// src/engine/read.ts, rendered by ReadProcessView.tsx), the
// [data-testid="read-status-progress"] progress line, and the six
// Metadata-section include toggles (MetadataEditor.tsx INCLUDE_GROUPS) —
// ALL of which default off independently of `metadata-enabled-toggle`
// (metadata redesign Tasks 1/8), so a file needs the master switch AND every
// include group its content depends on before a read can succeed:
//
//   0. fresh defaults (master off)     → failed at Locate metadata, 1/8
//   1. master ON, all groups still off → failed at Read schema, 4/8 (ladder step 1)
//   2. + include-schema ON             → failed at Read layout, 5/8 (ladder step 2)
//   3. + include-layout ON             → process view shows 8 ✓ steps, "8/8 steps"
//      (codecs/chunkIndex/descriptive/endianness all now on too — full ladder)
//   4. include-schema off              → failed at Read schema (variables/types msg)
//   5. include-layout off              → failed at Read layout
//   6. byte-shuffle + include-codecs off → read still SUCCEEDS (assume-identity,
//                                       same-size garble): decode-chunks notes
//                                       "assumed raw bytes", diff view reports
//                                       differences on the shuffled variable
//   7. RLE + include-codecs off        → failed at Decode chunks with the
//                                       expected/found byte-count mismatch
//   8. include-descriptive off         → still 8/8 success (reader never needs it)
//   9. per-chunk partitioning + entropy codec (deflate) + chunkIndex OFF →
//      read still SUCCEEDS end to end (Task 5's fix: per-chunk needs no
//      chunk index, offsets are computed from partition boundaries)
//
// Run: node tests/ui/scenario-read-process.mjs   (dev server must be running)

import { launch, shot, createHarness, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-read-process');

const OK = '✓';
const FAILED = '✗';
const SKIPPED = '–';

const STEP_IDS = [
  'verify-magic',
  'locate-metadata',
  'parse-metadata',
  'read-schema',
  'read-layout',
  'locate-chunks',
  'decode-chunks',
  'reassemble',
];

async function stepText(page, id) {
  return page
    .locator(`[data-testid="pane-right"] [data-testid="read-step-${id}"]`)
    .innerText()
    .catch(() => '');
}

async function progressText(page) {
  return page.locator('[data-testid="read-status-progress"]').innerText().catch(() => '');
}

async function setIncludeMetadata(page, on) {
  await page
    .locator('[data-testid="metadata-enabled-toggle"] button', { hasText: on ? /^Yes$/ : /^No$/ })
    .click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);
}

/** The six granular toggles use Radio testIdPrefix `${testid}-opt`. */
async function setIncludeGroup(page, testid, on) {
  await page.locator(`[data-testid="${testid}-opt-${on ? 'yes' : 'no'}"]`).click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);
}

const ALL_INCLUDE_TOGGLES = [
  'include-schema-toggle',
  'include-layout-toggle',
  'include-codecs-toggle',
  'include-chunk-index-toggle',
  'include-descriptive-toggle',
  'include-endianness-toggle',
];

async function setAllIncludeGroups(page, on) {
  for (const testid of ALL_INCLUDE_TOGGLES) {
    await setIncludeGroup(page, testid, on);
  }
}

async function setPaneViewMode(page, mode) {
  await page.locator(`[data-testid="pane-right"] [data-testid="view-mode-${mode}"]`).click();
  await page.waitForTimeout(300);
}

/** Add a codec to temperature (1st variable, column mode) via "+ Add codec". */
async function addCodecToTemperature(page, codecKey) {
  const codecsSection = page.locator('[data-testid="sidebar-section-codecs"]');
  await codecsSection.locator('select').first().selectOption(codecKey);
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);
}

async function removeCodec(page, codecLabel) {
  await page.locator(`button[aria-label="Remove ${codecLabel}"]`).click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);
}

async function main() {
  const { browser, page } = await launch();
  await waitForPipelineIdle(page);
  await page.locator('[data-testid="pane-dropdown-right"]').selectOption('read');
  await setPaneViewMode(page, 'process');

  // ── 0. Ladder walk: fresh defaults (master switch off too) → failed at
  //       Locate metadata, 1/8. All six include groups default off
  //       independently of the master switch (metadata redesign Tasks 1/8),
  //       so this is the true starting point before any toggle is touched. ──
  await shot(page, 'read-process-ladder-0-fresh');
  const pLadder0 = await progressText(page);
  h.check(
    'ladder 0: fresh defaults → progress "1/8 steps · failed at: Locate metadata"',
    pLadder0 === '1/8 steps · failed at: Locate metadata',
    `"${pLadder0}"`,
  );

  // ── Ladder step 1: master switch ON, all six include groups still off →
  //       schema is the first thing a real reader needs that isn't written,
  //       so it fails at Read schema (locate/parse succeed on the envelope
  //       alone — collectMetadata always emits metadata_format when enabled). ──
  await setIncludeMetadata(page, true);
  await shot(page, 'read-process-ladder-1-master-only');
  const pLadder1 = await progressText(page);
  h.check(
    'ladder 1: master ON, groups off → progress "3/8 steps · failed at: Read schema"',
    pLadder1 === '3/8 steps · failed at: Read schema',
    `"${pLadder1}"`,
  );

  // ── Ladder step 2: + include-schema ON → next thing missing is layout. ────
  await setIncludeGroup(page, 'include-schema-toggle', true);
  await shot(page, 'read-process-ladder-2-schema-on');
  const pLadder2 = await progressText(page);
  h.check(
    'ladder 2: + schema ON → progress "4/8 steps · failed at: Read layout"',
    pLadder2 === '4/8 steps · failed at: Read layout',
    `"${pLadder2}"`,
  );

  // ── Ladder step 3: + every remaining group ON → full success, 8/8. ────────
  await setIncludeGroup(page, 'include-layout-toggle', true);
  await setIncludeGroup(page, 'include-codecs-toggle', true);
  await setIncludeGroup(page, 'include-chunk-index-toggle', true);
  await setIncludeGroup(page, 'include-descriptive-toggle', true);
  await setIncludeGroup(page, 'include-endianness-toggle', true);
  await shot(page, 'read-process-ladder-3-all-on');
  const pLadder3 = await progressText(page);
  h.check('ladder 3: every group ON → progress "8/8 steps"', pLadder3 === '8/8 steps', `"${pLadder3}"`);

  // ── 1. Fully-enabled state → 8/8 ✓ in process view (the rest of this
  //       scenario's checks 4-8 below toggle individual groups off one at a
  //       time against this fully-on baseline). ─────────────────────────────
  await shot(page, 'read-process-all-ok');

  const stepCount = await page
    .locator('[data-testid="pane-right"] [data-testid^="read-step-"]')
    .count();
  h.check('process view renders exactly 8 read-step rows', stepCount === 8, `count=${stepCount}`);

  let allOk = true;
  const badSteps = [];
  for (const id of STEP_IDS) {
    const text = await stepText(page, id);
    if (!text.includes(OK) || text.includes(FAILED) || text.includes(SKIPPED)) {
      allOk = false;
      badSteps.push(id);
    }
  }
  h.check('all 8 steps show ok (✓, no ✗/–)', allOk, badSteps.join(',') || 'all ok');

  const p1 = await progressText(page);
  h.check('progress line reads "8/8 steps"', p1 === '8/8 steps', `"${p1}"`);

  // ── 2. Master toggle OFF → checklist replaces pane content in a
  //       NON-process mode; failed at Locate metadata; 1/8. ─────────────────
  await setPaneViewMode(page, 'hex'); // deliberately not process mode
  await setIncludeMetadata(page, false);
  await shot(page, 'read-process-master-off');

  const checklistVisible = await page
    .locator('[data-testid="pane-right"] [data-testid="read-process-view"]')
    .count();
  h.check(
    'master off: checklist replaces pane content even in hex mode',
    checklistVisible === 1,
    `read-process-view count=${checklistVisible}`,
  );
  const locateText = await stepText(page, 'locate-metadata');
  h.check('master off: locate-metadata step failed (✗)', locateText.includes(FAILED), locateText.slice(0, 80).replace(/\n/g, ' '));
  const magicText = await stepText(page, 'verify-magic');
  h.check('master off: verify-magic still ok (✓)', magicText.includes(OK));
  const parseText = await stepText(page, 'parse-metadata');
  h.check(
    'master off: parse-metadata skipped (– / not reached)',
    parseText.includes(SKIPPED) && parseText.includes('not reached'),
    parseText.slice(0, 80).replace(/\n/g, ' '),
  );
  const p2 = await progressText(page);
  h.check(
    'master off: progress "1/8 steps · failed at: Locate metadata"',
    p2 === '1/8 steps · failed at: Locate metadata',
    `"${p2}"`,
  );

  // Restore master ON; back to process mode for the rest.
  await setIncludeMetadata(page, true);
  await setPaneViewMode(page, 'process');

  // ── 3. include-schema off → failed at Read schema, message names
  //       variables/types. ──────────────────────────────────────────────────
  await setIncludeGroup(page, 'include-schema-toggle', false);
  await shot(page, 'read-process-schema-off');
  const schemaStep = await stepText(page, 'read-schema');
  h.check('schema off: read-schema step failed (✗)', schemaStep.includes(FAILED), schemaStep.slice(0, 80).replace(/\n/g, ' '));
  h.check(
    'schema off: failure detail mentions variables and storage types',
    /nothing describes the\s+variables/.test(schemaStep.replace(/\n/g, ' ')) && /storage types/.test(schemaStep),
    schemaStep.slice(0, 200).replace(/\n/g, ' '),
  );
  const p3 = await progressText(page);
  h.check(
    'schema off: progress "3/8 steps · failed at: Read schema"',
    p3 === '3/8 steps · failed at: Read schema',
    `"${p3}"`,
  );
  await setIncludeGroup(page, 'include-schema-toggle', true);

  // ── 4. include-layout off → failed at Read layout. ────────────────────────
  await setIncludeGroup(page, 'include-layout-toggle', false);
  await shot(page, 'read-process-layout-off');
  const layoutStep = await stepText(page, 'read-layout');
  h.check('layout off: read-layout step failed (✗)', layoutStep.includes(FAILED), layoutStep.slice(0, 80).replace(/\n/g, ' '));
  const p4 = await progressText(page);
  h.check(
    'layout off: progress "4/8 steps · failed at: Read layout"',
    p4 === '4/8 steps · failed at: Read layout',
    `"${p4}"`,
  );
  await setIncludeGroup(page, 'include-layout-toggle', true);

  // ── 5. Garbled success: byte-shuffle (size-preserving) on temperature,
  //       include-codecs off → read SUCCEEDS via assume-identity but values
  //       are garbled; decode-chunks notes the assumption; diff view reports
  //       differences. ──────────────────────────────────────────────────────
  await addCodecToTemperature(page, 'byte-shuffle');
  await setIncludeGroup(page, 'include-codecs-toggle', false);
  await shot(page, 'read-process-garbled-success');

  const readStatus5 = await page.locator('[data-testid="read-status"]').innerText();
  h.check(
    'byte-shuffle + codecs off: read still succeeds',
    /File parsed successfully/.test(readStatus5),
    readStatus5.slice(0, 120).replace(/\n/g, ' '),
  );
  const readNode = await page.locator('[data-testid="pipeline-stage-6"]').innerText();
  h.check('byte-shuffle + codecs off: pipeline Read node shows ✓', readNode.includes(OK), readNode.replace(/\n/g, ' '));
  const p5 = await progressText(page);
  h.check('byte-shuffle + codecs off: progress "8/8 steps"', p5 === '8/8 steps', `"${p5}"`);
  const decodeStep5 = await stepText(page, 'decode-chunks');
  h.check(
    'byte-shuffle + codecs off: decode-chunks notes "assumed raw bytes"',
    decodeStep5.includes('assumed raw bytes'),
    decodeStep5.slice(0, 200).replace(/\n/g, ' '),
  );

  // Diff view: enable "Show differences from original" and check the
  // shuffled variable's table diff summary reports a nonzero differing count.
  await page
    .locator('[data-testid="read-status"] button', { hasText: /^Yes$/ })
    .first()
    .click();
  await page.waitForTimeout(300);
  await setPaneViewMode(page, 'table');
  await page.waitForTimeout(400);
  await shot(page, 'read-process-garbled-diff');
  const diffSummary = await page
    .locator('[data-testid="pane-right"] [data-testid="table-diff-summary-temperature"]')
    .innerText()
    .catch(() => '');
  const diffMatch = diffSummary.replace(/\n/g, ' ').match(/(\d+) diff/);
  h.check(
    'byte-shuffle + codecs off: diff summary reports differences on temperature',
    !!diffMatch && Number(diffMatch[1]) > 0,
    `"${diffSummary.replace(/\n/g, ' ')}"`,
  );

  // Restore: diff off, byte-shuffle removed, back to process mode.
  await page
    .locator('[data-testid="read-status"] button', { hasText: /^No$/ })
    .first()
    .click();
  await page.waitForTimeout(300);
  await removeCodec(page, 'Byte Shuffle');
  await setPaneViewMode(page, 'process');

  // ── 6. RLE (size-changing) + include-codecs still off → decode-chunks
  //       fails: assumed-identity byte count doesn't match. ─────────────────
  await addCodecToTemperature(page, 'rle');
  await shot(page, 'read-process-rle-codecs-off');
  const decodeStep6 = (await stepText(page, 'decode-chunks')).replace(/\n/g, ' ');
  h.check('rle + codecs off: decode-chunks step failed (✗)', decodeStep6.includes(FAILED), decodeStep6.slice(0, 80));
  h.check(
    'rle + codecs off: detail names expected vs found byte counts',
    /expected \d+ bytes/.test(decodeStep6) && /found \d+ bytes/.test(decodeStep6),
    decodeStep6.slice(0, 300),
  );
  const p6 = await progressText(page);
  h.check(
    'rle + codecs off: progress "6/8 steps · failed at: Decode chunks"',
    p6 === '6/8 steps · failed at: Decode chunks',
    `"${p6}"`,
  );
  await removeCodec(page, 'RLE');
  await setIncludeGroup(page, 'include-codecs-toggle', true);

  // ── 7. include-descriptive off → reader never needed it: still 8/8. ──────
  await setIncludeGroup(page, 'include-descriptive-toggle', false);
  await shot(page, 'read-process-descriptive-off');
  const readStatus7 = await page.locator('[data-testid="read-status"]').innerText();
  h.check(
    'descriptive off: read still succeeds',
    /File parsed successfully/.test(readStatus7),
    readStatus7.slice(0, 120).replace(/\n/g, ' '),
  );
  const p7 = await progressText(page);
  h.check('descriptive off: progress "8/8 steps"', p7 === '8/8 steps', `"${p7}"`);

  // ── 8. Per-chunk partitioning + entropy codec (RLE) + chunk-index OFF →
  //       read still succeeds end to end (Task 5's fix: per-chunk files carry
  //       no cross-file byte offsets to compute, so they're resolved by
  //       filename/coords, not by the chunk_index — unlike single-file mode,
  //       where the same combo fails no-chunk-index). ──────────────────────
  await addCodecToTemperature(page, 'rle');
  await setIncludeGroup(page, 'include-chunk-index-toggle', false);
  await page
    .locator('[data-testid="sidebar-section-write"] button', { hasText: /^Per-chunk$/ })
    .click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);
  await shot(page, 'read-process-per-chunk-entropy-no-index');

  const readStatus8 = await page.locator('[data-testid="read-status"]').innerText();
  h.check(
    'per-chunk + rle + chunk-index off: read succeeds end to end',
    /File parsed successfully/.test(readStatus8),
    readStatus8.slice(0, 160).replace(/\n/g, ' '),
  );
  const p8 = await progressText(page);
  h.check('per-chunk + rle + chunk-index off: progress "8/8 steps"', p8 === '8/8 steps', `"${p8}"`);

  // Restore: single-file partitioning, chunk index on, RLE removed.
  await page
    .locator('[data-testid="sidebar-section-write"] button', { hasText: /^Single file$/ })
    .click();
  await page.waitForTimeout(300);
  await removeCodec(page, 'RLE');
  await setIncludeGroup(page, 'include-chunk-index-toggle', true);

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
