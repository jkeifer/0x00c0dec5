// Regression scenario: fixed-width text (charN) variables.
//
// Seeds one text variable (cities word set, stepped, char8 storage) plus one
// numeric variable, then checks the plan's Phase 3 list:
//   - table cells show words (not numbers)
//   - SchemaEditor shows the wordSet select (min/max hidden for text)
//   - TypeAssignConfig offers only char widths for text + truncated/lossless badge
//   - the Write-stage hex view's ASCII column shows the words
//   - the codec editor shows the Char[8] dtype label from the registry
//   - adding RLE keeps the read stage green and the reconstructed table matches
//   - switching to char4 truncates: badge appears and the diff view flags rows
//
// Run: node tests/ui/scenario-text-variable.mjs   (dev server must be running)

import { launch, shot, createHarness, seedStateAndReload } from './scenario-helpers.mjs';

const h = createHarness('scenario-text-variable');

const SEED_STATE = {
  dataModel: 'tabular',
  shape: [32],
  chunkShape: [32],
  interleaving: 'column',
  variables: [
    {
      id: 'city', name: 'city', color: '#61afef',
      logicalType: { type: 'text', min: 0, max: 0, wordSet: 'cities', generation: 'stepped' },
      typeAssignment: { storageDtype: 'char8' },
    },
    {
      id: 'humidity', name: 'humidity', color: '#98c379',
      logicalType: { type: 'integer', min: 0, max: 100, generation: 'stepped' },
      typeAssignment: { storageDtype: 'uint16' },
    },
  ],
  fieldPipelines: { city: [], humidity: [] },
  chunkPipeline: [],
  metadata: { customEntries: [], serialization: 'json', includeChunkIndex: true },
  write: {
    includeMetadata: true,
    magicNumber: '00C0DEC5',
    partitioning: 'single',
    metadataPlacement: 'header',
    chunkOrder: 'row-major',
    footerLocator: 'trailer',
  },
  ui: {
    leftPaneStage: 'values',
    rightPaneStage: 'write',
    leftPaneView: 'table',
    rightPaneView: 'hex',
    showDiff: false,
  },
};

async function main() {
  const { browser, page } = await launch({ fresh: true });
  await seedStateAndReload(page, { '0x00c0dec5-state-tabular': SEED_STATE });
  await page.waitForSelector('[data-testid="table-view"]');
  await page.waitForTimeout(500);

  // ── Table shows words ──
  const cell0 = (await page.locator('[data-testid="table-cell-city-0"]').textContent() ?? '').trim();
  h.check(
    'table cell for the text variable shows a word',
    /^[A-Za-z][A-Za-z .-]*$/.test(cell0) && cell0.length > 1,
    `cell0=${JSON.stringify(cell0)}`,
  );

  // ── SchemaEditor: wordSet select shown, min/max hidden for the text row ──
  const wordsetValue = await page.locator('[data-testid="wordset-select-0"]').inputValue().catch(() => null);
  h.check('wordSet select renders for the text variable with the seeded value', wordsetValue === 'cities', `value=${wordsetValue}`);
  const row0Text = (await page.locator('[data-testid="variable-row-0"]').innerText()).toLowerCase();
  h.check(
    'text variable row shows the longest-word hint and no min/max inputs',
    row0Text.includes('longest word') && !row0Text.includes('min') && !row0Text.includes('max'),
    JSON.stringify(row0Text.slice(0, 120)),
  );

  // ── TypeAssignConfig: char-only dtype select + lossy/lossless badge ──
  const typing = page.locator('[data-testid="sidebar-section-typing"]');
  const citySelect = typing.locator('select').first();
  const cityOptions = await citySelect.locator('option').allTextContents();
  h.check(
    'text variable dtype select offers exactly the char widths',
    JSON.stringify(cityOptions) === JSON.stringify(['Char[4]', 'Char[8]', 'Char[16]']),
    JSON.stringify(cityOptions),
  );
  h.check('text variable storage dtype select shows char8', (await citySelect.inputValue()) === 'char8');
  const humiditySelect = typing.locator('select').nth(1);
  const humidityOptions = await humiditySelect.locator('option').allTextContents();
  h.check(
    'numeric variable dtype select has no char options',
    humidityOptions.length === 8 && !humidityOptions.some((o) => o.startsWith('Char')),
    JSON.stringify(humidityOptions),
  );
  const typingTextChar8 = await typing.innerText();
  h.check(
    'typing section shows a truncated or lossless stat for the text variable',
    /truncated|lossless/.test(typingTextChar8),
    JSON.stringify(typingTextChar8.slice(0, 200)),
  );

  // ── Codec editor: registry-driven Char[8] label ──
  const codecsText = await page.locator('[data-testid="sidebar-section-codecs"]').innerText();
  h.check('codec section shows the Char[8] dtype label for the text variable', codecsText.includes('Char[8]'), JSON.stringify(codecsText.slice(0, 160)));

  // ── Hex view ASCII column shows the words. The Write stage's hex is
  // virtualized and header metadata pushes chunk bytes below the fold, so
  // check the Linearized stage, whose bytes START with the text variable. ──
  await page.locator('[data-testid="pane-dropdown-right"]').selectOption('linearized');
  await page.waitForTimeout(500);
  const rightPaneText = await page.locator('[data-testid="pane-right"]').innerText();
  const fragment = cell0.slice(0, Math.min(4, cell0.length));
  h.check(
    `hex view ASCII column contains the word fragment ${JSON.stringify(fragment)}`,
    rightPaneText.includes(fragment),
    `fragment=${fragment}`,
  );

  await shot(page, 'text-variable-char8');
  await page.locator('[data-testid="pane-dropdown-right"]').selectOption('write');
  await page.waitForTimeout(300);

  // ── Add RLE to the text variable's pipeline via the UI ──
  const addCodec = page.locator('[data-testid="sidebar-section-codecs"] select').first();
  await addCodec.selectOption('rle');
  await page.waitForTimeout(500);
  const rleStep = page.locator('[data-testid="codec-step-city-0"]');
  h.check('RLE step appears for the text variable', (await rleStep.count()) === 1);
  h.check(
    'RLE step shows the entropy output dtype (UInt8) from the registry flow',
    ((await rleStep.innerText().catch(() => '')) ?? '').includes('UInt8'),
  );

  // ── Read stage still succeeds and the reconstructed table matches ──
  await page.locator('[data-testid="pane-dropdown-right"]').selectOption('read');
  await page.waitForTimeout(300);
  await page.locator('[data-testid="pane-right"] [data-testid="view-mode-table"]').click();
  await page.waitForTimeout(500);
  const readStatusText = await page.locator('[data-testid="read-status"]').innerText();
  h.check('read succeeds with RLE on the text variable', readStatusText.includes('File parsed successfully'), JSON.stringify(readStatusText.slice(0, 120)));

  let allMatch = true;
  const mismatches = [];
  for (const i of [0, 7, 15, 31]) {
    const left = (await page.locator(`[data-testid="pane-left"] [data-testid="table-cell-city-${i}"]`).textContent() ?? '').trim();
    const right = (await page.locator(`[data-testid="pane-right"] [data-testid="table-cell-city-${i}"]`).textContent() ?? '').trim();
    if (left !== right || left.length === 0) {
      allMatch = false;
      mismatches.push(`row ${i}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
  }
  h.check('reconstructed (Read) table matches the Values table for the text variable', allMatch, mismatches.join('; '));

  // ── Switch to char4: truncation badge + diff view flags rows ──
  await citySelect.selectOption('char4');
  await page.waitForTimeout(500);
  const typingTextChar4 = await typing.innerText();
  h.check('char4 storage shows a truncated badge', /\d+ truncated/.test(typingTextChar4), JSON.stringify(typingTextChar4.slice(0, 200)));

  // Enable the diff toggle in the Read section (Yes/No radio buttons).
  await page.locator('[data-testid="sidebar-section-read"] button', { hasText: 'Yes' }).click();
  await page.waitForTimeout(500);
  const diffSummary = page.locator('[data-testid="table-diff-summary-city"]');
  const diffSummaryText = ((await diffSummary.innerText().catch(() => '')) ?? '').trim();
  h.check(
    'diff view flags truncated text rows in the summary',
    /\d+ diff/.test(diffSummaryText) && !diffSummaryText.includes('no diffs'),
    JSON.stringify(diffSummaryText),
  );
  const readStatusChar4 = await page.locator('[data-testid="read-status"]').innerText();
  h.check(
    'read status lists the text variable as lossy after truncation',
    readStatusChar4.includes('lossy') && readStatusChar4.includes('city'),
    JSON.stringify(readStatusChar4.slice(0, 200)),
  );

  await shot(page, 'text-variable-char4-diff');

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
