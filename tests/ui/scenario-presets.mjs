// Regression scenario: built-in presets (D10, remediation-plan.md, task 6.2;
// revised for the 4-preset era — 2 presets per data model, see
// `src/state/presets.ts`'s `PRESET_OPTIONS`).
//
// Presets are data-model specific: the Header dropdown only lists presets
// matching the active model (Parquet-adjacent/Avro-esque on tabular;
// GeoTIFFesque/Zarrish on array), and the 'Custom (restore)' slot is
// per-model. Loads each preset via the Header dropdown
// (data-testid="preset-select") and asserts:
//   - the dropdown lists only the active model's presets
//   - the select returns to the 'Presets…' placeholder after firing a load
//     (it's an action menu, not persistent state)
//   - the Read stage reports success for all four
//   - Parquet-adjacent: footer placement + trailer visible in Write config
//   - Avro-esque: header placement visible in Write config
//   - GeoTIFFesque: single file, provenance customEntries visible
//   - Zarrish: multiple files (per-chunk partitioning) in the FileExplorer
//   - 'Custom (restore)' appears only after a preset load, per model
//
// Run: node tests/ui/scenario-presets.mjs   (dev server must be running)

import { launch, shot, createHarness, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-presets');

async function readStatusText(page) {
  return page.locator('[data-testid="read-status"]').innerText().catch(() => '');
}

async function selectPreset(page, value) {
  await page.locator('[data-testid="preset-select"]').selectOption(value);
  await page.waitForTimeout(600);
  // Project 4's eager Pyodide init keeps the worker busy for the first few
  // seconds after boot — wait for the pipeline to actually go idle before
  // reading the read-status.
  await waitForPipelineIdle(page);
}

async function openSidebarSection(page, name) {
  const section = page.locator(`[data-testid="sidebar-section-${name}"]`);
  await section.scrollIntoViewIfNeeded();
  return section;
}

async function presetOptionValues(page) {
  return page
    .locator('[data-testid="preset-select"] option:not([hidden])')
    .evaluateAll((opts) => opts.map((o) => o.value));
}

async function switchModel(page, model) {
  await page.locator(`[data-testid="model-toggle-${model}"]`).click();
  await page.waitForTimeout(600);
}

async function main() {
  const { browser, page } = await launch();

  // ─── The select shows the placeholder, not a stage/model option ─────────
  const initialValue = await page.locator('[data-testid="preset-select"]').inputValue();
  h.check('preset select starts on the placeholder', initialValue === '', `got "${initialValue}"`);

  // ─── Model scoping: tabular lists only its two presets, no Custom yet ───
  const tabularOptions = await presetOptionValues(page);
  h.check(
    'tabular dropdown lists only Parquet-adjacent + Avro-esque (no array presets, no Custom before any load)',
    tabularOptions.length === 2 &&
      tabularOptions.includes('parquet-adjacent') &&
      tabularOptions.includes('avroesque'),
    `options = ${JSON.stringify(tabularOptions)}`,
  );

  // ─── Parquet-adjacent ────────────────────────────────────────────────
  await selectPreset(page, 'parquet-adjacent');

  const afterParquetValue = await page.locator('[data-testid="preset-select"]').inputValue();
  h.check(
    'preset select returns to the placeholder after loading Parquet-adjacent',
    afterParquetValue === '',
    `got "${afterParquetValue}"`,
  );

  const parquetReadText = await readStatusText(page);
  h.check(
    'Parquet-adjacent: read status shows success',
    /File parsed successfully/.test(parquetReadText),
    parquetReadText.slice(0, 160).replace(/\n/g, ' '),
  );

  const writeSection = await openSidebarSection(page, 'write');
  const writeSectionText = await writeSection.innerText();
  h.check(
    'Parquet-adjacent: Write config shows Footer placement active',
    /Footer/.test(writeSectionText),
    writeSectionText.slice(0, 200).replace(/\n/g, ' '),
  );
  const footerLocatorText = await page.locator('[data-testid="footer-locator-toggle"]').innerText();
  h.check(
    'Parquet-adjacent: footer locator control shows Length trailer active',
    /Length trailer/.test(footerLocatorText),
    footerLocatorText.replace(/\n/g, ' '),
  );
  await shot(page, 'preset-parquet-adjacent');

  const tabularOptionsAfterLoad = await presetOptionValues(page);
  h.check(
    'Custom (restore) appears in the tabular dropdown after a preset load',
    tabularOptionsAfterLoad.includes('custom'),
    `options = ${JSON.stringify(tabularOptionsAfterLoad)}`,
  );

  // ─── Avro-esque ──────────────────────────────────────────────────────
  await selectPreset(page, 'avroesque');

  const avroReadText = await readStatusText(page);
  h.check(
    'Avro-esque: read status shows success',
    /File parsed successfully/.test(avroReadText),
    avroReadText.slice(0, 160).replace(/\n/g, ' '),
  );

  const writeSectionAvro = await openSidebarSection(page, 'write');
  const writeSectionAvroText = await writeSectionAvro.innerText();
  h.check(
    'Avro-esque: Write config shows Header placement active',
    /Header/.test(writeSectionAvroText),
    writeSectionAvroText.slice(0, 200).replace(/\n/g, ' '),
  );
  await shot(page, 'preset-avroesque');

  // ─── Switch to N-d Array: dropdown lists only the array presets ─────────
  await switchModel(page, 'array');
  const arrayOptions = await presetOptionValues(page);
  h.check(
    'array dropdown lists exactly GeoTIFFesque + COG-esque + Zarrish (no tabular presets, no Custom before any array load)',
    arrayOptions.length === 3 &&
      arrayOptions.includes('geotiffesque') &&
      arrayOptions.includes('cog-esque') &&
      arrayOptions.includes('zarrish'),
    `options = ${JSON.stringify(arrayOptions)}`,
  );

  // ─── GeoTIFFesque ────────────────────────────────────────────────────
  await selectPreset(page, 'geotiffesque');

  const geotiffReadText = await readStatusText(page);
  h.check(
    'GeoTIFFesque: read status shows success',
    /File parsed successfully/.test(geotiffReadText),
    geotiffReadText.slice(0, 160).replace(/\n/g, ' '),
  );

  const metadataSection = await openSidebarSection(page, 'metadata');
  const sourceKeyInput = metadataSection.locator('input[data-testid^="metadata-custom-key-"]').first();
  const sourceKeyValue = await sourceKeyInput.inputValue().catch(() => '');
  h.check(
    'GeoTIFFesque: source provenance custom entry visible in Metadata section',
    sourceKeyValue === 'source',
    `first custom key = "${sourceKeyValue}"`,
  );

  const geotiffFileCount = await page.locator('[data-testid^="file-entry-"]').count();
  h.check(
    'GeoTIFFesque: single file shown in the file explorer (single partitioning)',
    geotiffFileCount === 1,
    `file count = ${geotiffFileCount}`,
  );
  await shot(page, 'preset-geotiffesque');

  // ─── Zarrish ─────────────────────────────────────────────────────────
  await selectPreset(page, 'zarrish');

  const zarrReadText = await readStatusText(page);
  h.check(
    'Zarrish: read status shows success',
    /File parsed successfully/.test(zarrReadText),
    zarrReadText.slice(0, 160).replace(/\n/g, ' '),
  );

  const fileEntries = page.locator('[data-testid^="file-entry-"]');
  const fileCount = await fileEntries.count();
  h.check(
    'Zarrish: multiple files shown in the file explorer (per-chunk partitioning)',
    fileCount > 1,
    `file count = ${fileCount}`,
  );
  await shot(page, 'preset-zarrish');

  // ─── Custom (restore), per-model ─────────────────────────────────────────
  // On the array model, "Custom" restores what was on screen immediately
  // before the FIRST array preset load (GeoTIFFesque) — the array
  // default state (1 chunk), not the Zarrish preset's multi-file layout.
  await selectPreset(page, 'custom');
  const afterCustomValue = await page.locator('[data-testid="preset-select"]').inputValue();
  h.check(
    'preset select returns to the placeholder after restoring Custom',
    afterCustomValue === '',
    `got "${afterCustomValue}"`,
  );
  const restoredFileCount = await page.locator('[data-testid^="file-entry-"]').count();
  h.check(
    'array Custom restores the pre-GeoTIFFesque array state (single file, not Zarrish\'s multi-file layout)',
    restoredFileCount === 1,
    `file count = ${restoredFileCount}`,
  );

  // Back on tabular, its own Custom slot restores the state from immediately
  // before the LAST tabular preset load (Avro-esque) — i.e. Parquet-adjacent's
  // own state, since the slot is overwritten on every preset load, not just
  // the first. Parquet-adjacent's shape (144769 rows) is therefore what comes
  // back, not the original default (32) or Avro-esque's own shape.
  await switchModel(page, 'tabular');
  await selectPreset(page, 'custom');
  const rowsValue = await page
    .locator('[data-testid="sidebar-section-schema"] [data-testid="shape-input"]')
    .inputValue()
    .catch(() => '');
  h.check(
    'tabular Custom restores the pre-Avro-esque state (Parquet-adjacent\'s 144769 rows)',
    rowsValue === '144769',
    `rows = "${rowsValue}"`,
  );

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
