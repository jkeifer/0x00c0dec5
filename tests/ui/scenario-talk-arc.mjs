// Regression scenario: the Phase 6 acceptance gate — the full "Talk Workflow"
// arc end to end, in ONE browser session, with no reloads and no localStorage
// devtools access (docs/remediation-plan.md, Phase 6 acceptance gate, as
// amended: the compression beat uses HUMIDITY — the stepped uint16 variable.
// Pressure is sorted-but-float32, and delta+RLE on IEEE-754 float diffs
// inflates rather than compresses by design; that inflation is documented as
// its own lesson, not a bug. Humidity is the clean compression beat.)
//
// Beats:
//   1. Fresh load: left pane Values/table with data; right pane Write.
//   2. Read pipeline strip Typed/Encoded byte counts. Add delta then rle to
//      humidity's codec pipeline. Assert Encoded byte count DROPS below its
//      pre-codec value, and capture entropy readings (assert entropy changed
//      — the byte-count drop is the hard assertion).
//   3. Load "Basically Parquet" via the preset dropdown. Assert footer
//      placement + trailer locator active, read-status success.
//   4. Download the file, read bytes from disk: first 4 bytes === PAR1 (50415231).
//   5. Toggle include-metadata OFF -> read-status failure w/ educational
//      message; ON -> success again.
//   6. Save checkpoint. Change shape, rename a variable, add a codec step.
//      Restore -> assert all three reverted.
//   7. Throughout: zero pageerrors; ErrorBoundary never shown.
//
// Run: node tests/ui/scenario-talk-arc.mjs   (dev server must be running)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, shot, createHarness, boundaryShown, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-talk-arc');

async function readStatusText(page) {
  return page.locator('[data-testid="read-status"]').innerText().catch(() => '');
}

async function openSidebarSection(page, slug) {
  const section = page.locator(`[data-testid="sidebar-section-${slug}"]`);
  await section.scrollIntoViewIfNeeded();
  return section;
}

/** Pipeline strip stage node text is "{Name}\n{byteCount}\t{entropy}" roughly
 * — read byteCount + entropy by parsing the two spans under the stage's
 * second row. Stage indices are fixed: 0 Values, 1 Typed, 2 Linearized,
 * 3 Encoded, 4 Metadata, 5 Write, 6 Read. */
async function stageStats(page, index) {
  const node = page.locator(`[data-testid="pipeline-stage-${index}"]`);
  const text = await node.innerText();
  // e.g. "Encoded\n64 B2.34 b/B" (no separator guaranteed by innerText, so
  // parse the byte-count and b/B tokens with regexes instead of splitting).
  const byteMatch = text.match(/([\d.]+)\s*(B|KB|MB|GB)\b/);
  const entropyMatch = text.match(/([\d.]+)\s*b\/B/);
  const byteCount = byteMatch ? parseFloat(byteMatch[1]) : NaN;
  const byteUnit = byteMatch ? byteMatch[2] : '';
  const entropy = entropyMatch ? parseFloat(entropyMatch[1]) : NaN;
  return { text, byteCount, byteUnit, entropy };
}

async function addCodecToVariable(page, varName, codecValue) {
  const codecsSection = page.locator('[data-testid="sidebar-section-codecs"]');
  await codecsSection.scrollIntoViewIfNeeded();
  // Column mode: each variable gets its own row, an outer <div> whose first
  // child holds a <span> with the variable's exact name text, followed by a
  // CodecPipelineEditor <select>. A fixed nth() index into "all selects in
  // the section" isn't safe once a preset is active — match the row by the
  // variable name span's EXACT text (not hasText substring, which could
  // false-positive on a name that's a substring of another), then narrow to
  // the candidate div containing exactly one <select> (the tightest
  // ancestor: the whole-section div and the bare name-row div both match
  // "has the name span" too, but hold 3+ or 0 selects respectively).
  const rowCandidates = codecsSection
    .locator('div')
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${varName}$`) }) });
  const candidateCount = await rowCandidates.count();
  let varRow = null;
  for (let i = 0; i < candidateCount; i++) {
    const candidate = rowCandidates.nth(i);
    if ((await candidate.locator('select').count()) === 1) {
      varRow = candidate;
      break;
    }
  }
  if (!varRow) throw new Error(`addCodecToVariable: could not locate ${varName}'s codec row`);
  await varRow.locator('select').first().selectOption(codecValue);
  await page.waitForTimeout(400);
  // Project 4's eager Pyodide init keeps the worker busy for the first few
  // seconds after boot, so early recomputes can land well after a flat wait —
  // wait for the pipeline to actually go idle before reading stage stats.
  await waitForPipelineIdle(page);
}

async function selectPreset(page, value) {
  await page.locator('[data-testid="preset-select"]').selectOption(value);
  await page.waitForTimeout(600);
  // The format presets fetch real curated data and run Pyodide codecs over
  // 723k values — the recompute takes seconds, and reading status after a
  // flat wait sees the stale last-good result. Wait for actual idle.
  await waitForPipelineIdle(page, 120_000);
}

async function setIncludeMetadata(page, on) {
  await page
    .locator('[data-testid="include-metadata-toggle"] button', { hasText: on ? /^Yes$/ : /^No$/ })
    .click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 120_000);
}

async function setShape(page, value) {
  const input = page.locator('[data-testid="shape-input"]');
  await input.fill(String(value));
  await input.blur(); // shape inputs commit on blur, not per keystroke
  await page.waitForTimeout(200);
}

/** Save a Playwright Download to a temp file and return its bytes as a Buffer. */
async function downloadToBuffer(download) {
  const tmpPath = path.join(os.tmpdir(), `0x00c0dec5-talk-arc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await download.saveAs(tmpPath);
  const buf = fs.readFileSync(tmpPath);
  fs.unlinkSync(tmpPath);
  return buf;
}

async function main() {
  const { browser, page, issues } = await launch({ fresh: true });

  // Track pageerrors across the WHOLE session (issues.pageerror already
  // accumulates from newContext's page.on('pageerror', ...) listener).

  // ─── Beat 1: fresh load — left pane Values/table with data; right pane Write ───
  const leftDropdown = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="pane-dropdown-left"]');
    return { value: sel.value, text: sel.options[sel.selectedIndex]?.text ?? '(none)' };
  });
  const leftHasTableView = (await page.locator('[data-testid="pane-left"] [data-testid="table-view"]').count()) > 0;
  const leftCellCount = await page.locator('[data-testid="pane-left"] [data-testid^="table-cell-"]').count();
  h.check(
    'beat1: left pane shows Values/Table with data',
    leftDropdown.value === 'values' && leftHasTableView && leftCellCount > 0,
    `dropdown=${JSON.stringify(leftDropdown)} hasTableView=${leftHasTableView} cellCount=${leftCellCount}`,
  );

  const rightDropdown = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="pane-dropdown-right"]');
    return { value: sel.value, text: sel.options[sel.selectedIndex]?.text ?? '(none)' };
  });
  h.check(
    'beat1: right pane shows Write',
    rightDropdown.value === 'write' && rightDropdown.text === 'Write',
    JSON.stringify(rightDropdown),
  );
  h.check('beat1: ErrorBoundary not shown', !(await boundaryShown(page)));
  await shot(page, 'talk-arc-1');

  // ─── Beat 2: read Typed/Encoded byte counts, add delta+rle to humidity ───
  const typedBefore = await stageStats(page, 1);
  const encodedBefore = await stageStats(page, 3);
  h.check(
    'beat2: Typed stage byte count is readable before adding codecs',
    Number.isFinite(typedBefore.byteCount),
    typedBefore.text.replace(/\n/g, ' | '),
  );
  h.check(
    'beat2: Encoded stage byte count is readable before adding codecs',
    Number.isFinite(encodedBefore.byteCount),
    encodedBefore.text.replace(/\n/g, ' | '),
  );

  await addCodecToVariable(page, 'humidity', 'delta');
  const humidityStepsAfterDelta = await page.locator('[data-testid^="codec-step-humidity-"]').count();
  h.check('beat2: delta codec step added to humidity', humidityStepsAfterDelta === 1, `count=${humidityStepsAfterDelta}`);

  await addCodecToVariable(page, 'humidity', 'rle');
  const humidityStepsAfterRle = await page.locator('[data-testid^="codec-step-humidity-"]').count();
  h.check('beat2: rle codec step added to humidity', humidityStepsAfterRle === 2, `count=${humidityStepsAfterRle}`);

  const encodedAfter = await stageStats(page, 3);

  // Compare on a common unit. formatByteCount may switch units (B -> KB) as
  // the value shrinks/grows, so normalize both readings to bytes using the
  // unit token captured alongside each value.
  const UNIT_MULTIPLIER = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
  const beforeBytes = encodedBefore.byteCount * (UNIT_MULTIPLIER[encodedBefore.byteUnit] ?? 1);
  const afterBytes = encodedAfter.byteCount * (UNIT_MULTIPLIER[encodedAfter.byteUnit] ?? 1);

  h.check(
    'beat2: Encoded byte count DROPS below its pre-codec value after delta+rle on humidity',
    afterBytes < beforeBytes,
    `before=${encodedBefore.text.replace(/\n/g, ' ')} (${beforeBytes} B) after=${encodedAfter.text.replace(/\n/g, ' ')} (${afterBytes} B)`,
  );

  h.check(
    'beat2: Encoded stage entropy reading changed after delta+rle on humidity',
    Number.isFinite(encodedBefore.entropy) && Number.isFinite(encodedAfter.entropy) && encodedBefore.entropy !== encodedAfter.entropy,
    `before entropy=${encodedBefore.entropy} b/B after entropy=${encodedAfter.entropy} b/B`,
  );

  h.check('beat2: ErrorBoundary not shown', !(await boundaryShown(page)));
  await shot(page, 'talk-arc-2');

  // ─── Beat 3: load "Parquet-adjacent", assert footer+trailer, read success ───
  await selectPreset(page, 'parquet-adjacent');

  const parquetReadText = await readStatusText(page);
  h.check(
    'beat3: read-status shows success after loading Basically Parquet',
    /File parsed successfully/.test(parquetReadText),
    parquetReadText.slice(0, 160).replace(/\n/g, ' '),
  );

  const writeSection = await openSidebarSection(page, 'write');
  const writeSectionText = await writeSection.innerText();
  h.check(
    'beat3: Write config shows Footer placement active',
    /Footer/.test(writeSectionText),
    writeSectionText.slice(0, 200).replace(/\n/g, ' '),
  );

  const footerLocatorText = await page.locator('[data-testid="footer-locator-toggle"]').innerText();
  h.check(
    'beat3: footer locator control shows Length trailer active',
    /Length trailer/.test(footerLocatorText),
    footerLocatorText.replace(/\n/g, ' '),
  );

  h.check('beat3: ErrorBoundary not shown', !(await boundaryShown(page)));
  await shot(page, 'talk-arc-3');

  // ─── Beat 4: download the file, verify first 4 bytes === PAR1 magic ───
  // (the Parquet-adjacent preset's magic is 50415231 "PAR1", not the app's
  // default 00C0DEC5 — the preset rename/rework changed this beat's magic)
  await openSidebarSection(page, 'write');
  const downloadBtn = page.locator('[data-testid="download-file-0"]').first();
  const hasDownloadBtn = (await downloadBtn.count()) > 0;
  h.check('beat4: download-file-0 button present', hasDownloadBtn);

  let magicHex = '(no download)';
  if (hasDownloadBtn) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadBtn.click(),
    ]);
    const bytes = await downloadToBuffer(download);
    magicHex = bytes.slice(0, 4).toString('hex');
  }
  h.check(
    'beat4: downloaded file bytes START WITH the preset magic 50415231 (PAR1)',
    magicHex === '50415231',
    `first 4 bytes = ${magicHex}`,
  );

  h.check('beat4: ErrorBoundary not shown', !(await boundaryShown(page)));
  await shot(page, 'talk-arc-4');

  // ─── Beat 5: toggle include-metadata OFF -> failure, ON -> success ───
  await setIncludeMetadata(page, false);
  const offText = await readStatusText(page);
  h.check(
    'beat5: include-metadata OFF -> read-status shows failure with educational message',
    /Read failed/.test(offText) && !/File parsed successfully/.test(offText) && /Include metadata/i.test(offText),
    offText.slice(0, 220).replace(/\n/g, ' '),
  );
  await shot(page, 'talk-arc-5a');

  await setIncludeMetadata(page, true);
  const onText = await readStatusText(page);
  h.check(
    'beat5: include-metadata ON -> read-status shows success again',
    /File parsed successfully/.test(onText),
    onText.slice(0, 160).replace(/\n/g, ' '),
  );

  h.check('beat5: ErrorBoundary not shown', !(await boundaryShown(page)));
  await shot(page, 'talk-arc-5');

  // ─── Beat 6: checkpoint / restore across three config changes ───
  const shapeBefore = await page.locator('[data-testid="shape-input"]').inputValue();
  const varName0Before = await page.locator('[data-testid="variable-name-0"]').inputValue();
  const codecStepsBefore = await page.locator('[data-testid^="codec-step-tmax-"]').count();

  await page.locator('[data-testid="save-checkpoint"]').click();
  await page.waitForTimeout(150);
  const saveLabel = await page.locator('[data-testid="save-checkpoint"]').innerText();
  h.check('beat6: save-checkpoint shows a saved confirmation', /Saved/.test(saveLabel), `label="${saveLabel}"`);

  // Change 1: shape.
  const newShape = String(Number(shapeBefore || '32') + 5);
  await setShape(page, newShape);
  const shapeAfterChange = await page.locator('[data-testid="shape-input"]').inputValue();
  h.check('beat6: shape changed', shapeAfterChange === newShape, `expected=${newShape} got=${shapeAfterChange}`);

  // Change 2: rename a variable.
  const nameInput = page.locator('[data-testid="variable-name-0"]');
  await nameInput.fill('renamed_var');
  await nameInput.dispatchEvent('change');
  await page.waitForTimeout(200);
  const varName0AfterChange = await page.locator('[data-testid="variable-name-0"]').inputValue();
  h.check('beat6: variable name changed', varName0AfterChange === 'renamed_var', `got=${varName0AfterChange}`);

  // Change 3: add a codec step (byte-shuffle, to humidity — its pipeline
  // already has delta+rle from beat 2, so this both changes count from its
  // own pre-restore baseline and confirms restore un-adds it).
  await addCodecToVariable(page, 'tmax', 'byte-shuffle');
  const codecStepsAfterChange = await page.locator('[data-testid^="codec-step-tmax-"]').count();
  h.check(
    'beat6: a codec step was added to humidity before restore',
    codecStepsAfterChange === codecStepsBefore + 1,
    `before=${codecStepsBefore} after=${codecStepsAfterChange}`,
  );

  await shot(page, 'talk-arc-6a');

  // Restore.
  await page.locator('[data-testid="restore-checkpoint"]').click();
  await page.waitForTimeout(300);

  const shapeAfterRestore = await page.locator('[data-testid="shape-input"]').inputValue();
  h.check(
    'beat6: shape input reverted after restore',
    shapeAfterRestore === shapeBefore,
    `expected=${shapeBefore} got=${shapeAfterRestore}`,
  );

  const varName0AfterRestore = await page.locator('[data-testid="variable-name-0"]').inputValue();
  h.check(
    'beat6: variable name reverted after restore',
    varName0AfterRestore === varName0Before,
    `expected=${varName0Before} got=${varName0AfterRestore}`,
  );

  const codecStepsAfterRestore = await page.locator('[data-testid^="codec-step-tmax-"]').count();
  h.check(
    'beat6: codec step count reverted after restore',
    codecStepsAfterRestore === codecStepsBefore,
    `expected=${codecStepsBefore} got=${codecStepsAfterRestore}`,
  );

  h.check('beat6: ErrorBoundary not shown', !(await boundaryShown(page)));
  await shot(page, 'talk-arc-6');

  // ─── Beat 7: zero pageerrors across the whole session; ErrorBoundary never shown ───
  h.check(
    'beat7: zero pageerrors across the whole session',
    issues.pageerror.length === 0,
    issues.pageerror.slice(0, 5).join(' | '),
  );
  h.check('beat7: ErrorBoundary never shown at any point (final check)', !(await boundaryShown(page)));
  await shot(page, 'talk-arc-7');

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
