// Regression scenario: dataset presets + format presets.
//
// Datasets now apply SCHEMA + METADATA ONLY (no codecs); the curated codec/
// chunking/write configs moved into the four top-level FORMAT presets
// (Parquet-adjacent, Avro-esque, GeoTIFFesque, Zarrish), each carrying a
// `dataset` ref so loading one fetches real data.
//
// Covers:
//   1. Tabular dataset select (ghcn-daily): attribution shown, schema locked,
//      table renders, read succeeds. (Schema+metadata only — no codecs.)
//   2. Compression sanity: load the GeoTIFFesque format preset (which carries
//      the codec config + etopo-dem dataset) and assert Encoded < Typed there.
//   3. Unlock: selecting "custom" clears the lock and attribution.
//   4. Persistence: dataset selection survives a reload.
//   5. Array datasets: etopo-dem and sst-field both lock + compute.
//   6. Failure path: a blocked manifest fetch shows dataset-error and leaves
//      state on custom rather than partially applying.
//   7. All four format presets load from the Header preset-select (pins the
//      owner's "Parquet preset does not load" report): variables appear and
//      read-status reports success for each. Model-scoped, so we switch models.
//
// Run: node tests/ui/scenario-dataset-presets.mjs   (dev server must be running)

import { launch, shot, createHarness, waitForPipelineIdle, safeReload } from './scenario-helpers.mjs';

const h = createHarness('scenario-dataset-presets');

/**
 * Unlike scenario-helpers' seedStateAndReload (a blind localStorage.setItem
 * baked into a persistent addInitScript — fine for a single boot, but this
 * scenario drives several *organic* reloads afterward via app interactions,
 * e.g. check 4's persistence-across-reload test), this scenario needs a
 * seed that survives every future reload in the same context WITHOUT
 * clobbering what the app itself has since saved (its dataset selection).
 * addInitScript can't be unregistered, so instead the injected script does a
 * shallow JSON merge onto whatever's already in localStorage for that key
 * (mirroring deepMergeDefaults' one-level-deep intent for this narrow use:
 * only `write` needs forcing) rather than overwriting the whole blob.
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

const TABULAR_KEY = '0x00c0dec5-state-tabular';
const ARRAY_KEY = '0x00c0dec5-state-array';

async function main() {
  const { browser, page, issues } = await launch({ fresh: true });
  await waitForPipelineIdle(page);

  // DEFAULT_STATE.write.includeMetadata is false (the app's honest-failure
  // teaching default — Read fails without metadata by design). This scenario
  // cares about dataset selection, not that lesson, so seed metadata on for
  // BOTH data models (tabular now, array before check 5 switches models) the
  // same way scenario-linearization-endianness.mjs does for its 2-D case.
  await seedMergedAndReload(page, {
    [TABULAR_KEY]: { write: { includeMetadata: true } },
    [ARRAY_KEY]: { write: { includeMetadata: true } },
  });
  await waitForPipelineIdle(page);

  // ─── (1) Tabular dataset: ghcn-daily ─────────────────────────────────────
  await page.locator('[data-testid="sidebar-section-schema"]').scrollIntoViewIfNeeded();

  const options = await page.locator('[data-testid="dataset-select"] option').allInnerTexts();
  h.check(
    '(1) dataset-select has ghcn-daily + custom options on fresh tabular load',
    (await page.locator('[data-testid="dataset-select"] option[value="ghcn-daily"]').count()) === 1 &&
      (await page.locator('[data-testid="dataset-select"] option[value="custom"]').count()) === 1,
    options.join(', '),
  );

  await page.locator('[data-testid="dataset-select"]').selectOption('ghcn-daily');
  await page.waitForSelector('[data-testid="dataset-loading"]', { state: 'detached', timeout: 30_000 }).catch(() => {});
  await waitForPipelineIdle(page, 30_000);

  const attribution = await page.locator('[data-testid="dataset-attribution"]').innerText().catch(() => '');
  h.check('(1) dataset-attribution visible with non-empty text', attribution.trim().length > 0, attribution);

  h.check('(1) shape-input disabled while dataset active', await page.locator('[data-testid="shape-input"]').isDisabled());
  h.check('(1) add-variable disabled while dataset active', await page.locator('[data-testid="add-variable"]').isDisabled());
  h.check('(1) variable-name-0 disabled while dataset active', await page.locator('[data-testid="variable-name-0"]').isDisabled());

  // Table view renders with real/fixture ghcn-daily values. Variable IDs are
  // minted as `{datasetId}-{name}` (buildDatasetApplication) but table cell
  // testids key off `variable.name` (TableView.tsx), so no prefix here.
  await page.locator('[data-testid="pane-dropdown-left"]').selectOption('values');
  await page.waitForTimeout(200);
  await page.locator('[data-testid="pane-left"] [data-testid="view-mode-table"]').click();
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page);
  const tmaxCell = await page
    .locator('[data-testid="pane-left"] [data-testid="table-cell-tmax-0"]')
    .innerText()
    .catch(() => null);
  h.check('(1) table view renders ghcn-daily values', tmaxCell !== null && tmaxCell.trim().length > 0, `tmax[0]=${tmaxCell}`);

  const readStatus1 = await readStatusText(page);
  h.check(
    '(1) read status shows success, no failure text',
    /File parsed successfully/.test(readStatus1) && !/Read failed/.test(readStatus1),
    readStatus1.slice(0, 120).replace(/\n/g, ' '),
  );
  await shot(page, 'dataset-presets-1-ghcn-daily');

  // ─── (2) Compression sanity via the GeoTIFFesque FORMAT preset ────────────
  // Datasets no longer apply codecs, so the ghcn dataset above has Encoded ==
  // Typed. The codec story now lives in the format presets: load GeoTIFFesque
  // (array, etopo-dem + delta/deflate) on the array model and assert Encoded <
  // Typed there. deflate is Pyodide-backed — wait for the runtime first.
  await page.locator('[data-testid="model-toggle-array"]').click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 30_000);

  const deflateReady = await page
    .waitForFunction(() => {
      const opt = document.querySelector('option[value="deflate"]');
      return opt !== null && !opt.disabled;
    }, { timeout: 180_000 })
    .then(() => true)
    .catch(() => false);
  h.check('(2) compression runtime (deflate) ready before loading GeoTIFFesque', deflateReady);

  await page.locator('[data-testid="preset-select"]').selectOption('geotiffesque');
  await page.waitForSelector('[data-testid="dataset-loading"]', { state: 'detached', timeout: 60_000 }).catch(() => {});
  await waitForPipelineIdle(page, 90_000);

  const typedBytes = await stageByteCount(page, 1);
  const encodedBytes = await stageByteCount(page, 3);
  h.check(
    '(2) GeoTIFFesque preset codecs shrink Encoded stage below Typed stage',
    typedBytes !== null && encodedBytes !== null && encodedBytes < typedBytes,
    `typed=${typedBytes} encoded=${encodedBytes}`,
  );
  await shot(page, 'dataset-presets-2-geotiffesque');

  // Back to tabular; the ghcn-daily selection from check 1 persisted per-model.
  await page.locator('[data-testid="model-toggle-tabular"]').click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 30_000);
  const backToGhcn = await page.locator('[data-testid="dataset-select"]').inputValue();
  h.check('(2) tabular ghcn-daily selection persisted across the model round-trip', backToGhcn === 'ghcn-daily', backToGhcn);

  // ─── (3) Unlock via custom ────────────────────────────────────────────────
  await page.locator('[data-testid="dataset-select"]').selectOption('custom');
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page);

  h.check('(3) shape-input re-enabled after selecting custom', !(await page.locator('[data-testid="shape-input"]').isDisabled()));
  h.check('(3) dataset-attribution gone after selecting custom', (await page.locator('[data-testid="dataset-attribution"]').count()) === 0);
  const datasetSelectValue3 = await page.locator('[data-testid="dataset-select"]').inputValue();
  h.check('(3) dataset-select value is custom', datasetSelectValue3 === 'custom', datasetSelectValue3);

  const readStatus3 = await readStatusText(page);
  h.check(
    '(3) pipeline still computes with generated values after unlock',
    /File parsed successfully/.test(readStatus3),
    readStatus3.slice(0, 120).replace(/\n/g, ' '),
  );

  // ─── (4) Persistence across reload ────────────────────────────────────────
  await page.locator('[data-testid="dataset-select"]').selectOption('ghcn-daily');
  await page.waitForSelector('[data-testid="dataset-loading"]', { state: 'detached', timeout: 30_000 }).catch(() => {});
  await waitForPipelineIdle(page, 30_000);
  const attributionBeforeReload = await page.locator('[data-testid="dataset-attribution"]').innerText().catch(() => '');

  await safeReload(page);
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 30_000);

  const datasetSelectValue4 = await page.locator('[data-testid="dataset-select"]').inputValue();
  h.check('(4) dataset-select value survives reload', datasetSelectValue4 === 'ghcn-daily', datasetSelectValue4);
  const attributionAfterReload = await page.locator('[data-testid="dataset-attribution"]').innerText().catch(() => '');
  h.check(
    '(4) dataset-attribution still rendered after reload',
    attributionAfterReload.trim().length > 0 && attributionAfterReload === attributionBeforeReload,
    attributionAfterReload,
  );
  const readStatus4 = await readStatusText(page);
  h.check(
    '(4) pipeline computes after reload (worker refetched values)',
    /File parsed successfully/.test(readStatus4),
    readStatus4.slice(0, 120).replace(/\n/g, ' '),
  );
  await shot(page, 'dataset-presets-4-persistence');

  // ─── (5) Array datasets ───────────────────────────────────────────────────
  await page.locator('[data-testid="model-toggle-array"]').click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 30_000);

  await page.locator('[data-testid="sidebar-section-schema"]').scrollIntoViewIfNeeded();
  const arrayOptions = await page.locator('[data-testid="dataset-select"] option').allInnerTexts();
  h.check(
    '(5) array model dataset-select offers etopo-dem + sst-field',
    (await page.locator('[data-testid="dataset-select"] option[value="etopo-dem"]').count()) === 1 &&
      (await page.locator('[data-testid="dataset-select"] option[value="sst-field"]').count()) === 1,
    arrayOptions.join(', '),
  );

  await page.locator('[data-testid="dataset-select"]').selectOption('etopo-dem');
  await page.waitForSelector('[data-testid="dataset-loading"]', { state: 'detached', timeout: 60_000 }).catch(() => {});
  await waitForPipelineIdle(page, 60_000);

  h.check('(5) etopo-dem: shape-input-0 disabled (locked)', await page.locator('[data-testid="shape-input-0"]').isDisabled());
  const etopoAttribution = await page.locator('[data-testid="dataset-attribution"]').innerText().catch(() => '');
  h.check('(5) etopo-dem: attribution shown', etopoAttribution.trim().length > 0, etopoAttribution);
  const readStatusEtopo = await readStatusText(page);
  h.check(
    '(5) etopo-dem: read succeeds',
    /File parsed successfully/.test(readStatusEtopo),
    readStatusEtopo.slice(0, 120).replace(/\n/g, ' '),
  );
  await shot(page, 'dataset-presets-5-etopo-dem');

  // sst-field uses zstd (pyodide-backed) — wait for the runtime to be ready
  // before selecting, same pattern as scenario-real-codecs.mjs.
  const zstdReady = await page
    .waitForFunction(() => {
      const opt = document.querySelector('option[value="zstd"]');
      return opt !== null && !opt.disabled;
    }, { timeout: 180_000 })
    .then(() => true)
    .catch(() => false);
  h.check('(5) compression runtime (zstd) ready before selecting sst-field', zstdReady);

  await page.locator('[data-testid="dataset-select"]').selectOption('sst-field');
  await page.waitForSelector('[data-testid="dataset-loading"]', { state: 'detached', timeout: 60_000 }).catch(() => {});
  await waitForPipelineIdle(page, 60_000);

  h.check('(5) sst-field: shape-input-0 disabled (locked)', await page.locator('[data-testid="shape-input-0"]').isDisabled());
  const sstAttribution = await page.locator('[data-testid="dataset-attribution"]').innerText().catch(() => '');
  h.check('(5) sst-field: attribution shown', sstAttribution.trim().length > 0, sstAttribution);
  const readStatusSst = await readStatusText(page);
  h.check(
    '(5) sst-field: read succeeds (zstd round-trips)',
    /File parsed successfully/.test(readStatusSst),
    readStatusSst.slice(0, 120).replace(/\n/g, ' '),
  );
  await shot(page, 'dataset-presets-5-sst-field');

  // Back to custom so check 6 starts from an unlocked state.
  await page.locator('[data-testid="dataset-select"]').selectOption('custom');
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page);

  // ─── (6) Failure path: blocked manifest fetch ────────────────────────────
  // registry.ts's loadManifest promise-caches per DatasetId at module scope —
  // etopo-dem's manifest already resolved successfully in check 5, so
  // routing alone would never be hit (the cached promise short-circuits the
  // fetch). Route BEFORE reloading so the route is live before any app code
  // runs, and the reload resets the JS module cache along with everything else.
  await page.route('**/data-dev/datasets/etopo-dem/manifest.json', (route) => route.abort());
  await safeReload(page);
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page, 30_000);

  await page.locator('[data-testid="dataset-select"]').selectOption('etopo-dem');
  const errorEl = page.locator('[data-testid="dataset-error"]');
  const errorAppeared = await errorEl.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  h.check('(6) dataset-error appears when manifest fetch is blocked', errorAppeared);
  const errorText = await errorEl.innerText().catch(() => '');
  h.check('(6) dataset-error has non-empty message', errorText.trim().length > 0, errorText);

  const datasetSelectValue6 = await page.locator('[data-testid="dataset-select"]').inputValue();
  h.check('(6) dataset-select stays on custom after failed apply', datasetSelectValue6 === 'custom', datasetSelectValue6);
  h.check('(6) shape-input still enabled (schema not locked by failed apply)', !(await page.locator('[data-testid="shape-input-0"]').isDisabled()));

  await page.unroute('**/data-dev/datasets/etopo-dem/manifest.json');
  await shot(page, 'dataset-presets-6-failure');

  // ─── (7) All four format presets load from the Header preset-select ───────
  // Pins the owner's "Parquet preset does not load" report. Presets are
  // model-scoped, so switch to each preset's model first. Each uses a
  // Pyodide-backed codec, so the runtime must be ready (it is by now — checks
  // 2 and 5 already loaded it). We fresh-reload (clears the aborted-route
  // state and any half-applied dataset) and seed metadata on for both models.
  await safeReload(page);
  await seedMergedAndReload(page, {
    [TABULAR_KEY]: { write: { includeMetadata: true } },
    [ARRAY_KEY]: { write: { includeMetadata: true } },
  });
  await waitForPipelineIdle(page, 30_000);

  const presetsByModel = [
    { model: 'tabular', presets: ['parquet-adjacent', 'avroesque'] },
    { model: 'array', presets: ['geotiffesque', 'zarrish'] },
  ];
  for (const { model, presets } of presetsByModel) {
    await page.locator(`[data-testid="model-toggle-${model}"]`).click();
    await page.waitForTimeout(400);
    await waitForPipelineIdle(page, 30_000);
    // Runtime must be ready (deflate/zstd) before loading — presets compress.
    await page
      .waitForFunction(() => {
        const opt = document.querySelector('option[value="deflate"]');
        return opt !== null && !opt.disabled;
      }, { timeout: 180_000 })
      .catch(() => {});
    for (const key of presets) {
      const present = await page.locator(`[data-testid="preset-select"] option[value="${key}"]`).count();
      h.check(`(7) ${key} offered in the ${model} preset-select`, present === 1);

      await page.locator('[data-testid="preset-select"]').selectOption(key);
      await page.waitForSelector('[data-testid="dataset-loading"]', { state: 'detached', timeout: 60_000 }).catch(() => {});
      await waitForPipelineIdle(page, 90_000);

      const varCount = await page.locator('[data-testid^="variable-row-"]').count();
      h.check(`(7) ${key}: variables appear after load`, varCount > 0, `variables=${varCount}`);

      const readStatus = await readStatusText(page);
      h.check(
        `(7) ${key}: read-status reports success`,
        /File parsed successfully/.test(readStatus) && !/Read failed/.test(readStatus),
        readStatus.slice(0, 120).replace(/\n/g, ' '),
      );
      // Return to a clean custom state before the next preset (avoids stacking
      // dataset locks / snapshots between loads).
      await page.locator('[data-testid="dataset-select"]').selectOption('custom');
      await page.waitForTimeout(200);
      await waitForPipelineIdle(page, 30_000);
    }
  }
  await shot(page, 'dataset-presets-7-all-presets');

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
