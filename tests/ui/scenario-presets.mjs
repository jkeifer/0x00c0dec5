// Regression scenario: built-in presets (D10, remediation-plan.md, task 6.2).
//
// Loads each preset via the Header dropdown (data-testid="preset-select")
// and asserts:
//   - the select returns to the 'Presets…' placeholder after firing a load
//     (it's an action menu, not persistent state)
//   - the Read stage reports success for all three
//   - Basically Parquet: footer placement + trailer visible in Write config
//   - Basically Zarr: multiple files in the FileExplorer
//   - Basically GeoTIFF: the crs custom entry is visible in the Metadata section
//
// Run: node tests/ui/scenario-presets.mjs   (dev server must be running)

import { launch, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-presets');

async function readStatusText(page) {
  return page.locator('[data-testid="read-status"]').innerText().catch(() => '');
}

async function selectPreset(page, value) {
  await page.locator('[data-testid="preset-select"]').selectOption(value);
  await page.waitForTimeout(600);
}

async function openSidebarSection(page, name) {
  const section = page.locator(`[data-testid="sidebar-section-${name}"]`);
  await section.scrollIntoViewIfNeeded();
  return section;
}

async function main() {
  const { browser, page } = await launch();

  // ─── The select shows the placeholder, not a stage/model option ─────────
  const initialValue = await page.locator('[data-testid="preset-select"]').inputValue();
  h.check('preset select starts on the placeholder', initialValue === '', `got "${initialValue}"`);

  // ─── Basically Parquet ────────────────────────────────────────────────
  await selectPreset(page, 'basically-parquet');

  const afterParquetValue = await page.locator('[data-testid="preset-select"]').inputValue();
  h.check(
    'preset select returns to the placeholder after loading Basically Parquet',
    afterParquetValue === '',
    `got "${afterParquetValue}"`,
  );

  const parquetReadText = await readStatusText(page);
  h.check(
    'Basically Parquet: read status shows success',
    /File parsed successfully/.test(parquetReadText),
    parquetReadText.slice(0, 160).replace(/\n/g, ' '),
  );

  const writeSection = await openSidebarSection(page, 'write');
  const writeSectionText = await writeSection.innerText();
  h.check(
    'Basically Parquet: Write config shows Footer placement active',
    /Footer/.test(writeSectionText),
    writeSectionText.slice(0, 200).replace(/\n/g, ' '),
  );
  const footerLocatorText = await page.locator('[data-testid="footer-locator-toggle"]').innerText();
  h.check(
    'Basically Parquet: footer locator control shows Length trailer active',
    /Length trailer/.test(footerLocatorText),
    footerLocatorText.replace(/\n/g, ' '),
  );
  await shot(page, 'preset-basically-parquet');

  // ─── Basically GeoTIFF ────────────────────────────────────────────────
  await selectPreset(page, 'basically-geotiff');

  const geotiffReadText = await readStatusText(page);
  h.check(
    'Basically GeoTIFF: read status shows success',
    /File parsed successfully/.test(geotiffReadText),
    geotiffReadText.slice(0, 160).replace(/\n/g, ' '),
  );

  const metadataSection = await openSidebarSection(page, 'metadata');
  const crsKeyInput = metadataSection.locator('input[data-testid^="metadata-custom-key-"]').first();
  const crsKeyValue = await crsKeyInput.inputValue().catch(() => '');
  h.check(
    'Basically GeoTIFF: crs custom entry visible in Metadata section',
    crsKeyValue === 'crs',
    `first custom key = "${crsKeyValue}"`,
  );
  await shot(page, 'preset-basically-geotiff');

  // ─── Basically Zarr ─────────────────────────────────────────────────────
  await selectPreset(page, 'basically-zarr');

  const zarrReadText = await readStatusText(page);
  h.check(
    'Basically Zarr: read status shows success',
    /File parsed successfully/.test(zarrReadText),
    zarrReadText.slice(0, 160).replace(/\n/g, ' '),
  );

  const fileEntries = page.locator('[data-testid^="file-entry-"]');
  const fileCount = await fileEntries.count();
  h.check(
    'Basically Zarr: multiple files shown in the file explorer',
    fileCount > 1,
    `file count = ${fileCount}`,
  );
  await shot(page, 'preset-basically-zarr');

  // ─── Custom (restore) ───────────────────────────────────────────────────
  // After three preset loads, "Custom" should restore whatever was on screen
  // immediately before the FIRST preset load (Basically Parquet) — the
  // pre-preset default state (shape [32]).
  await selectPreset(page, 'custom');
  const afterCustomValue = await page.locator('[data-testid="preset-select"]').inputValue();
  h.check(
    'preset select returns to the placeholder after restoring Custom',
    afterCustomValue === '',
    `got "${afterCustomValue}"`,
  );

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
