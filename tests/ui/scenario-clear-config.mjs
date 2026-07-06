// Regression scenario: the Header's Clear button (plan Phase 3 —
// clear-config, active model -> empty state).
//
// Seeds BOTH models' state keys, then:
//   - dismissing the confirm dialog leaves state (DOM + localStorage) unchanged
//   - accepting empties the ACTIVE (tabular) model: zero variable rows, the
//     Schema section still renders, the tabular key persists variables: [],
//     and the array model's key stays byte-identical
//   - the cleared (empty) persisted state survives a reload
//   - no pageerror at any point
//
// Run: node tests/ui/scenario-clear-config.mjs   (dev server must be running)

import {
  launch,
  shot,
  createHarness,
  safeEvaluate,
  seedStateAndReload,
} from './scenario-helpers.mjs';

const h = createHarness('scenario-clear-config');

const TABULAR_KEY = '0x00c0dec5-state-tabular';
const ARRAY_KEY = '0x00c0dec5-state-array';

// Non-default tabular state (16 rows, not the default 32) so we can tell the
// seed took, plus a distinctive array state whose bytes must never change.
// Partial objects are fine: loadState default-merges them (variables become
// the three starters).
const TABULAR_SEED = JSON.stringify({ dataModel: 'tabular', shape: [16], chunkShape: [8] });
const ARRAY_SEED = JSON.stringify({
  dataModel: 'array',
  shape: [4, 4],
  chunkShape: [2, 2],
  interleaving: 'row',
});

async function variableRowCount(page) {
  return page.locator('[data-testid^="variable-row-"]').count();
}

async function readKey(page, key) {
  return safeEvaluate(page, (k) => localStorage.getItem(k), key);
}

async function main() {
  const { browser, page, issues } = await launch();

  // One persistent dialog handler; per-pass behavior via `dialogAction`.
  let dialogAction = 'dismiss';
  let lastDialogMessage = '';
  page.on('dialog', async (d) => {
    lastDialogMessage = d.message();
    if (dialogAction === 'accept') await d.accept();
    else await d.dismiss();
  });

  await seedStateAndReload(page, { [TABULAR_KEY]: TABULAR_SEED, [ARRAY_KEY]: ARRAY_SEED });
  await page.waitForTimeout(800); // let the mount-time debounced autosave settle

  const seededRows = await variableRowCount(page);
  const seededShape = await page.locator('[data-testid="shape-input"]').inputValue().catch(() => '');
  h.check(
    'seed took: 3 starter variables and shape 16 on the tabular model',
    seededRows === 3 && seededShape === '16',
    `rows = ${seededRows}, shape = "${seededShape}"`,
  );

  const clearButton = page.locator('[data-testid="clear-config"]');
  h.check('Clear button renders in the header', (await clearButton.count()) === 1);

  // ─── Dismiss pass: nothing changes ──────────────────────────────────────
  const tabularBeforeDismiss = await readKey(page, TABULAR_KEY);
  dialogAction = 'dismiss';
  await clearButton.click();
  await page.waitForTimeout(700);

  h.check(
    'confirm dialog names the active (Tabular) model',
    /Tabular/.test(lastDialogMessage) && /configuration/.test(lastDialogMessage),
    lastDialogMessage,
  );
  const rowsAfterDismiss = await variableRowCount(page);
  const tabularAfterDismiss = await readKey(page, TABULAR_KEY);
  h.check(
    'dismissing the dialog leaves the DOM unchanged (still 3 variable rows)',
    rowsAfterDismiss === 3,
    `rows = ${rowsAfterDismiss}`,
  );
  h.check(
    'dismissing the dialog leaves the tabular state key unchanged',
    tabularAfterDismiss === tabularBeforeDismiss,
  );

  // ─── Accept pass: active model empties, everything else untouched ───────
  dialogAction = 'accept';
  await clearButton.click();
  await page.waitForTimeout(700);

  const rowsAfterClear = await variableRowCount(page);
  h.check('accepting clears all variable rows', rowsAfterClear === 0, `rows = ${rowsAfterClear}`);
  h.check(
    'Schema section still renders after clearing',
    (await page.locator('[data-testid="sidebar-section-schema"]').count()) === 1,
  );
  h.check(
    'add-variable button still available after clearing',
    (await page.locator('[data-testid="add-variable"]').count()) === 1,
  );
  await shot(page, 'clear-config-empty');

  const tabularCleared = await readKey(page, TABULAR_KEY);
  let clearedParsed = null;
  try {
    clearedParsed = JSON.parse(tabularCleared);
  } catch {
    /* handled by the check below */
  }
  h.check(
    'tabular key persisted with variables: [] and empty fieldPipelines',
    clearedParsed !== null &&
      Array.isArray(clearedParsed.variables) &&
      clearedParsed.variables.length === 0 &&
      Object.keys(clearedParsed.fieldPipelines ?? { nonEmpty: 1 }).length === 0,
    (tabularCleared ?? 'null').slice(0, 120),
  );
  const arrayAfterClear = await readKey(page, ARRAY_KEY);
  h.check(
    'array model key is byte-identical to its seed (other model untouched)',
    arrayAfterClear === ARRAY_SEED,
    (arrayAfterClear ?? 'null').slice(0, 120),
  );

  // ─── Cleared state survives a reload ────────────────────────────────────
  // The first seed's init script re-runs on every navigation and would
  // resurrect the pre-clear tabular state, so re-seed the tabular key with
  // exactly what the app itself persisted after the clear (later init
  // scripts win). This still exercises the real risk: the load path
  // rendering a persisted zero-variable state.
  await seedStateAndReload(page, { [TABULAR_KEY]: tabularCleared });
  await page.waitForTimeout(500);
  const rowsAfterReload = await variableRowCount(page);
  h.check(
    'cleared state persists across reload (still zero variable rows)',
    rowsAfterReload === 0,
    `rows = ${rowsAfterReload}`,
  );
  h.check(
    'Schema section renders after reloading the cleared state',
    (await page.locator('[data-testid="sidebar-section-schema"]').count()) === 1,
  );

  h.check('no pageerror during the scenario', issues.pageerror.length === 0, issues.pageerror.join('; '));

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
