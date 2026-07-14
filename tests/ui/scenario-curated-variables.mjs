// Regression scenario: per-variable curated sources.
//
// Task 5 (curated-variables project) replaced the schema-wide dataset picker
// (`dataset-select`/`APPLY_DATASET`) with a per-row source select on each
// Schema variable (`variable-source-{index}`), bound via `Variable.source =
// { datasetId, variableName }` and resolved against the static
// `CURATED_VARIABLES` catalog (src/datasets/registry.ts). Selecting a source
// locks only the logicalType-family controls on that row — name and shape
// stay editable — and the worker fills values by tiling/cropping the real
// dataset array to the schema's shape (src/engine/sourceFill.ts).
//
// Covers:
//   1. Ad-hoc curated pick: set a row's source to ghcn-daily/tmax and back to
//      custom, asserting the lock/unlock and value swap at each step.
//   2. Tile/crop: sst-field/sst (real shape 1024x1024) cropped at [200,200]
//      and tiled at [1100,1100] — both read successfully.
//   3. Persistence: a seeded source ref survives reload; worker refetches.
//   4. Failure path: blocking the manifest fetch surfaces the worker's error
//      (About modal's diagnostics — the only surface a failed *background*
//      compute has, since a prior good result is retained/stale rather than
//      replaced); recovery works once unblocked.
//   5. All four format presets load from the Header preset-select; GeoTIFFesque
//      still shows 3 variables and Encoded < Typed.
//   6. Zero pageerrors overall.
//
// Run: node tests/ui/scenario-curated-variables.mjs   (dev server must be running)

import { launch, shot, createHarness, waitForPipelineIdle, safeReload } from './scenario-helpers.mjs';

const h = createHarness('scenario-curated-variables');

/**
 * Unlike scenario-helpers' seedStateAndReload (a blind localStorage.setItem
 * baked into a persistent addInitScript — fine for a single boot, but this
 * scenario drives several *organic* reloads afterward via app interactions,
 * e.g. check 3's persistence-across-reload test), this scenario needs a seed
 * that survives every future reload in the same context WITHOUT clobbering
 * what the app itself has since saved (its source selection). addInitScript
 * can't be unregistered, so instead the injected script does a shallow JSON
 * merge onto whatever's already in localStorage for that key (mirroring
 * deepMergeDefaults' one-level-deep intent for this narrow use: only `write`
 * needs forcing) rather than overwriting the whole blob.
 */
async function seedMergedAndReload(page, entries) {
  await page.context().addInitScript((seed) => {
    for (const [k, patch] of Object.entries(seed)) {
      let existing = {};
      try { existing = JSON.parse(localStorage.getItem(k) ?? '{}') ?? {}; } catch { existing = {}; }
      const merged = { ...existing, ...patch };
      for (const key of Object.keys(patch)) {
        if (patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key])) {
          merged[key] = { ...(existing[key] ?? {}), ...patch[key] };
        }
      }
      localStorage.setItem(k, JSON.stringify(merged));
    }
  }, entries);
  await safeReload(page);
}

function parseByteCount(text) {
  const m = text.match(/([\d.]+)\s*(B|KB|MB|GB)\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2] === 'GB' ? 1024 ** 3 : m[2] === 'MB' ? 1024 ** 2 : m[2] === 'KB' ? 1024 : 1;
  return n * mult;
}

async function stageByteCount(page, index) {
  const text = await page.locator(`[data-testid="pipeline-stage-${index}"]`).innerText();
  return parseByteCount(text);
}

async function readStatusText(page) {
  return page.locator('[data-testid="read-status"]').innerText().catch(() => '');
}

async function waitDeflateReady(page, timeout = 180_000) {
  return page
    .waitForFunction(() => {
      const opt = document.querySelector('option[value="deflate"]');
      return opt !== null && !opt.disabled;
    }, { timeout })
    .then(() => true)
    .catch(() => false);
}

const TABULAR_KEY = '0x00c0dec5-state-tabular';
const ARRAY_KEY = '0x00c0dec5-state-array';

async function main() {
  const { browser, page, issues } = await launch({ fresh: true });
  await waitForPipelineIdle(page);

  // DEFAULT_STATE.write.includeMetadata is false (the app's honest-failure
  // teaching default — Read fails without metadata by design). This scenario
  // cares about curated sources, not that lesson, so seed metadata on for
  // both data models (tabular now, array before check 2 switches models).
  await seedMergedAndReload(page, {
    [TABULAR_KEY]: { write: { includeMetadata: true } },
    [ARRAY_KEY]: { write: { includeMetadata: true } },
  });
  await waitForPipelineIdle(page);

  // ─── (1) Ad-hoc curated pick on a tabular row ────────────────────────────
  await page.locator('[data-testid="sidebar-section-schema"]').scrollIntoViewIfNeeded();

  // Row 0 exists on the default tabular schema. Baseline: custom, unlocked.
  const sourceSelect0 = page.locator('[data-testid="variable-source-0"]');
  h.check('(1) variable-source-0 present with a custom baseline', (await sourceSelect0.inputValue()) === 'custom');
  h.check('(1) variable-name-0 editable before picking a source', !(await page.locator('[data-testid="variable-name-0"]').isDisabled()));

  const optionValues = await page.locator('[data-testid="variable-source-0"] option').evaluateAll((els) => els.map((el) => el.value));
  h.check(
    '(1) variable-source-0 offers ghcn-daily/tmax on the tabular model',
    optionValues.includes('ghcn-daily/tmax'),
    optionValues.join(', '),
  );

  const genValueBefore = await page.locator('[data-testid="table-cell-0-0"]').innerText().catch(() => null);

  await sourceSelect0.selectOption('ghcn-daily/tmax');
  await page.waitForTimeout(200);
  await waitForPipelineIdle(page, 30_000);

  h.check('(1) attribution hint appears after picking a curated source', (await page.locator('[data-testid="variable-source-attribution-0"]').innerText()).trim().length > 0);
  // logicalType-family controls locked: the type select is the first <select>
  // in the "Logical type + params" row — query relative to the row.
  const row0 = page.locator('[data-testid="variable-row-0"]');
  const logicalTypeSelectDisabled = await row0.locator('select').nth(1).isDisabled(); // 0 = source select
  h.check('(1) logicalType select disabled while a curated source is bound', logicalTypeSelectDisabled);
  h.check('(1) variable-name-0 STILL EDITABLE with a curated source bound', !(await page.locator('[data-testid="variable-name-0"]').isDisabled()));
  h.check('(1) shape-input STILL EDITABLE with a curated source bound', !(await page.locator('[data-testid="shape-input"]').isDisabled()));

  // Table shows real values now — switch the left pane to Values/table to see them.
  await page.locator('[data-testid="pane-dropdown-left"]').selectOption('values');
  await page.waitForTimeout(200);
  await page.locator('[data-testid="pane-left"] [data-testid="view-mode-table"]').click();
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page);
  const variableName0 = await page.locator('[data-testid="variable-name-0"]').inputValue();
  const tmaxCell = await page
    .locator(`[data-testid="pane-left"] [data-testid="table-cell-${variableName0}-0"]`)
    .innerText()
    .catch(() => null);
  h.check('(1) table view renders a real ghcn-daily/tmax value', tmaxCell !== null && tmaxCell.trim().length > 0, `tmax[0]=${tmaxCell}`);

  const readStatus1 = await readStatusText(page);
  h.check(
    '(1) read status shows success after binding a curated source',
    /File parsed successfully/.test(readStatus1) && !/Read failed/.test(readStatus1),
    readStatus1.slice(0, 120).replace(/\n/g, ' '),
  );
  await shot(page, 'curated-variables-1-ghcn-tmax');

  // Back to custom: hint gone, unlocked, values regenerate.
  await sourceSelect0.selectOption('custom');
  await page.waitForTimeout(200);
  await waitForPipelineIdle(page, 30_000);

  h.check('(1) attribution hint gone after reverting to custom', (await page.locator('[data-testid="variable-source-attribution-0"]').count()) === 0);
  const logicalTypeSelectDisabledAfter = await row0.locator('select').nth(1).isDisabled();
  h.check('(1) logicalType select re-enabled after reverting to custom', !logicalTypeSelectDisabledAfter);
  const readStatus1b = await readStatusText(page);
  h.check(
    '(1) pipeline recomputes with generated values after reverting to custom',
    /File parsed successfully/.test(readStatus1b),
    readStatus1b.slice(0, 120).replace(/\n/g, ' '),
  );
  const genValueAfter = await page.locator(`[data-testid="pane-left"] [data-testid="table-cell-${variableName0}-0"]`).innerText().catch(() => null);
  h.check(
    '(1) value at row 0 changed from the curated value back to a generated one',
    genValueAfter !== null && genValueAfter !== tmaxCell,
    `before=${tmaxCell} after=${genValueAfter} (fresh-generated baseline was ${genValueBefore})`,
  );

  // ─── (2) Tile/crop: sst-field/sst on the array model ─────────────────────
  await page.locator('[data-testid="model-toggle-array"]').click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 30_000);
  await page.locator('[data-testid="sidebar-section-schema"]').scrollIntoViewIfNeeded();

  const arraySourceSelect0 = page.locator('[data-testid="variable-source-0"]');
  const arrayOptionValues = await arraySourceSelect0.locator('option').evaluateAll((els) => els.map((el) => el.value));
  h.check(
    '(2) variable-source-0 offers sst-field/sst on the array model',
    arrayOptionValues.includes('sst-field/sst'),
    arrayOptionValues.join(', '),
  );

  await arraySourceSelect0.selectOption('sst-field/sst');
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page, 60_000);

  // Default array shape is 1-D ([32]) — add a second dim to match
  // sst-field's natural 2-D shape before setting the crop/tile shapes.
  const dimCountBefore = await page.locator('[data-testid^="shape-input-"]').count();
  if (dimCountBefore < 2) {
    await page.getByRole('button', { name: '+ Dim' }).click();
    await page.waitForTimeout(200);
    await waitForPipelineIdle(page, 30_000);
  }

  // Crop: [200, 200] is smaller than sst-field's real natural shape (1024x1024).
  await page.locator('[data-testid="shape-input-0"]').fill('200');
  await page.locator('[data-testid="shape-input-1"]').fill('200');
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page, 60_000);

  const readStatus2crop = await readStatusText(page);
  h.check(
    '(2) sst-field/sst crop at [200,200] reads successfully',
    /File parsed successfully/.test(readStatus2crop),
    readStatus2crop.slice(0, 120).replace(/\n/g, ' '),
  );

  // Tile: [1100, 1100] is larger than 1024 on both dims -> wraps (tiles).
  await page.locator('[data-testid="shape-input-0"]').fill('1100');
  await page.locator('[data-testid="shape-input-1"]').fill('1100');
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 90_000);

  const readStatus2tile = await readStatusText(page);
  h.check(
    '(2) sst-field/sst tile at [1100,1100] settles and reads successfully',
    /File parsed successfully/.test(readStatus2tile),
    readStatus2tile.slice(0, 120).replace(/\n/g, ' '),
  );
  h.check('(2) no pageerror after the tile-shape resize', issues.pageerror.length === 0, issues.pageerror.slice(0, 3).join(' | '));
  await shot(page, 'curated-variables-2-tile-crop');

  // Reset the array shape/source so later checks (5) start clean-ish (format
  // presets overwrite the whole state anyway, but avoid leaving a slow shape
  // active in case of failure mid-scenario).
  await arraySourceSelect0.selectOption('custom');
  await page.waitForTimeout(200);
  await waitForPipelineIdle(page, 30_000);

  // ─── (3) Persistence across reload ────────────────────────────────────────
  await page.locator('[data-testid="model-toggle-tabular"]').click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 30_000);
  await page.locator('[data-testid="sidebar-section-schema"]').scrollIntoViewIfNeeded();

  await page.locator('[data-testid="variable-source-0"]').selectOption('ghcn-daily/tmax');
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page, 30_000);

  const variableName0Before = await page.locator('[data-testid="variable-name-0"]').inputValue();
  await page.locator('[data-testid="pane-dropdown-left"]').selectOption('values');
  await page.waitForTimeout(200);
  await page.locator('[data-testid="pane-left"] [data-testid="view-mode-table"]').click();
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page);
  const valueBeforeReload = await page
    .locator(`[data-testid="pane-left"] [data-testid="table-cell-${variableName0Before}-0"]`)
    .innerText()
    .catch(() => null);

  await safeReload(page);
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 30_000);

  const sourceValueAfterReload = await page.locator('[data-testid="variable-source-0"]').inputValue();
  h.check('(3) variable-source-0 selection survives reload', sourceValueAfterReload === 'ghcn-daily/tmax', sourceValueAfterReload);

  const readStatus3 = await readStatusText(page);
  h.check(
    '(3) pipeline computes after reload (worker refetched source values)',
    /File parsed successfully/.test(readStatus3),
    readStatus3.slice(0, 120).replace(/\n/g, ' '),
  );

  await page.locator('[data-testid="pane-dropdown-left"]').selectOption('values');
  await page.waitForTimeout(200);
  await page.locator('[data-testid="pane-left"] [data-testid="view-mode-table"]').click();
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page);
  const variableName0After = await page.locator('[data-testid="variable-name-0"]').inputValue();
  const valueAfterReload = await page
    .locator(`[data-testid="pane-left"] [data-testid="table-cell-${variableName0After}-0"]`)
    .innerText()
    .catch(() => null);
  h.check(
    '(3) value still real (same as before reload) after refetch',
    valueAfterReload !== null && valueAfterReload === valueBeforeReload,
    `before=${valueBeforeReload} after=${valueAfterReload}`,
  );
  await shot(page, 'curated-variables-3-persistence');

  // Revert to custom before the failure-path check so it starts clean.
  await page.locator('[data-testid="variable-source-0"]').selectOption('custom');
  await page.waitForTimeout(200);
  await waitForPipelineIdle(page);

  // ─── (4) Failure path: blocked manifest fetch ────────────────────────────
  // registry.ts's loadManifest promise-caches per DatasetId at module scope —
  // ghcn-daily's manifest already resolved successfully above, so routing
  // alone would never be hit (the cached promise short-circuits the fetch).
  // Route BEFORE reloading so the route is live before any app code runs
  // (the reload also resets the JS module cache, including that promise
  // cache, along with everything else).
  await page.route('**/data-dev/datasets/ghcn-daily/manifest.json', (route) => route.abort());
  await safeReload(page);
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 30_000);

  const readStatusBeforeFailure = await readStatusText(page);
  h.check(
    '(4) pipeline has a good baseline result before introducing the failing source',
    /File parsed successfully/.test(readStatusBeforeFailure),
    readStatusBeforeFailure.slice(0, 120).replace(/\n/g, ' '),
  );

  await page.locator('[data-testid="sidebar-section-schema"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="variable-source-0"]').selectOption('ghcn-daily/tmax');
  // The worker's compute for this state throws (source values not loaded --
  // manifest fetch aborted) and posts ok:false. A prior good result already
  // exists, so useWorkerPipeline's `result` stays the stale last-good value
  // (App.tsx: bootError only fires when result === null) — the only visible
  // surface for this *background* failure is diagnostics.lastError, shown in
  // the About modal's collapsed Performance section. Give the worker time to
  // round-trip the failed compute, then open the modal and check it.
  await page.waitForTimeout(3000);

  await page.locator('[data-testid="about-button"]').click();
  await page.waitForSelector('[data-testid="about-modal"]', { state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="about-performance-toggle"]').click();
  await page.waitForTimeout(200);
  // The thrown error is the raw fetch failure from loadManifest (route.abort()
  // -> "Failed to fetch"), not computeValuesStage's "source values: ..."
  // message — that one only fires when a ref resolved but came back the wrong
  // shape/missing, not when the manifest fetch itself failed. Assert the
  // surface renders a real (non-empty) message, not a specific string.
  const lastErrorText = await page.locator('[data-testid="about-modal"]').innerText();
  const lastErrorLine = lastErrorText.split('\n').find((l) => l.includes('Last error'));
  h.check(
    '(4) About modal surfaces a non-empty worker error after the blocked fetch',
    lastErrorLine !== undefined && lastErrorLine.replace('Last error:', '').trim().length > 0,
    lastErrorLine ?? '(no "Last error" line)',
  );
  // The stale read-status (from before the failing selection) is still what's
  // shown -- the app doesn't silently claim success for the broken state, it
  // just doesn't (yet) have a way to update the strip for a failed compute.
  const readStatusDuringFailure = await readStatusText(page);
  h.check(
    '(4) read-status is unchanged (stale last-good), not silently claiming success for the broken state',
    readStatusDuringFailure === readStatusBeforeFailure,
    readStatusDuringFailure.slice(0, 120).replace(/\n/g, ' '),
  );
  await shot(page, 'curated-variables-4-failure');
  await page.locator('[data-testid="about-modal"]').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);

  // Recovery: unblock the route and trigger a recompute (reselect the same
  // source — a no-op state-wise, so force it via reverting to custom then
  // back, which is a genuine state change that re-triggers resolveSourceValues).
  await page.unroute('**/data-dev/datasets/ghcn-daily/manifest.json');
  await page.locator('[data-testid="variable-source-0"]').selectOption('custom');
  await page.waitForTimeout(200);
  await waitForPipelineIdle(page, 30_000);
  await page.locator('[data-testid="variable-source-0"]').selectOption('ghcn-daily/tmax');
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page, 30_000);

  const readStatusRecovered = await readStatusText(page);
  h.check(
    '(4) recompute succeeds after unblocking the manifest route',
    /File parsed successfully/.test(readStatusRecovered),
    readStatusRecovered.slice(0, 120).replace(/\n/g, ' '),
  );

  // Clean slate for check 5.
  await page.locator('[data-testid="variable-source-0"]').selectOption('custom');
  await page.waitForTimeout(200);
  await waitForPipelineIdle(page, 30_000);

  // ─── (5) All four format presets load from the Header preset-select ──────
  // Pins the owner's "Parquet preset does not load" report. Presets are
  // model-scoped, so switch to each preset's model first. Each uses a
  // Pyodide-backed codec, so the runtime must be ready. A fresh reload here
  // clears the aborted-route state from check 4; the seedMergedAndReload
  // addInitScript from the top of this scenario is still registered on this
  // context, so `write.includeMetadata` stays forced without re-seeding.
  await safeReload(page);
  await waitForPipelineIdle(page, 30_000);

  const presetsByModel = [
    { model: 'tabular', presets: ['parquet-adjacent', 'avroesque'] },
    { model: 'array', presets: ['geotiffesque', 'zarrish'] },
  ];
  for (const { model, presets } of presetsByModel) {
    await page.locator(`[data-testid="model-toggle-${model}"]`).click();
    await page.waitForTimeout(400);
    await waitForPipelineIdle(page, 30_000);
    await waitDeflateReady(page);
    for (const key of presets) {
      const present = await page.locator(`[data-testid="preset-select"] option[value="${key}"]`).count();
      h.check(`(5) ${key} offered in the ${model} preset-select`, present === 1);

      await page.locator('[data-testid="preset-select"]').selectOption(key);
      await page.waitForTimeout(300);
      await waitForPipelineIdle(page, 90_000);

      const varCount = await page.locator('[data-testid^="variable-row-"]').count();
      h.check(`(5) ${key}: variables appear after load`, varCount > 0, `variables=${varCount}`);

      const readStatus = await readStatusText(page);
      h.check(
        `(5) ${key}: read-status reports success`,
        /File parsed successfully/.test(readStatus) && !/Read failed/.test(readStatus),
        readStatus.slice(0, 120).replace(/\n/g, ' '),
      );

      if (key === 'geotiffesque') {
        const geotiffVarNames = await page.locator('[data-testid^="variable-name-"]').evaluateAll(
          (els) => els.map((el) => el.value ?? el.textContent ?? ''),
        );
        h.check(
          '(5) GeoTIFFesque: 3 variables present (elevation + 2 generated bands)',
          geotiffVarNames.length === 3 &&
            geotiffVarNames.includes('elevation') &&
            geotiffVarNames.includes('slope') &&
            geotiffVarNames.includes('hillshade'),
          geotiffVarNames.join(', '),
        );
        const typedBytes = await stageByteCount(page, 1);
        const encodedBytes = await stageByteCount(page, 3);
        h.check(
          '(5) GeoTIFFesque preset codecs shrink Encoded stage below Typed stage',
          typedBytes !== null && encodedBytes !== null && encodedBytes < typedBytes,
          `typed=${typedBytes} encoded=${encodedBytes}`,
        );
      }
    }
  }
  await shot(page, 'curated-variables-5-all-presets');

  // ─── zero pageerrors across the whole session ────────────────────────────
  h.check(
    'zero pageerrors across the whole session',
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
