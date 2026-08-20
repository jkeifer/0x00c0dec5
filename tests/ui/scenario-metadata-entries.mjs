// Regression scenario: Metadata stage's Entries view (metadata redesign
// Task 9) — MetadataEntriesView.tsx, wired as the default view mode for the
// Metadata stage in StagePane.tsx.
//
// Covers: selecting the Metadata stage defaults to the Entries view; rows
// render for both JSON and Binary serialization; a Binary row shows a
// "tag N · type" badge while a JSON row does not.
//
// Run: node tests/ui/scenario-metadata-entries.mjs   (dev server must be running)

import { launch, shot, createHarness, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-metadata-entries');

async function setIncludeMetadata(page, on) {
  await page
    .locator('[data-testid="metadata-enabled-toggle"] button', { hasText: on ? /^Yes$/ : /^No$/ })
    .click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);
}

async function setSerialization(page, format) {
  await page
    .locator('[data-testid="sidebar-section-metadata"] button', { hasText: format === 'json' ? /^JSON$/ : /^Binary$/ })
    .click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);
}

async function setIncludeGroup(page, testid, on) {
  await page.locator(`[data-testid="${testid}-opt-${on ? 'yes' : 'no'}"]`).click();
  await page.waitForTimeout(500);
  await waitForPipelineIdle(page);
}

async function main() {
  const { browser, page } = await launch();
  await waitForPipelineIdle(page);

  await setIncludeMetadata(page, true);
  // DEFAULT_STATE ships every include-group off — only the ungated
  // `metadata_format` envelope key would show. Turn schema on so the view
  // actually has multiple rows to exercise (schema/logical_types/
  // metadata_format). Layout is also on, since the override-lie
  // check below overrides the `shape` key, which only collectMetadata emits
  // (and MetadataEditor's autoEntries/override-note only recognizes) when
  // include.layout is true.
  await setIncludeGroup(page, 'include-schema-toggle', true);
  await setIncludeGroup(page, 'include-layout-toggle', true);

  // ── Select Metadata stage in the LEFT pane (default view mode 'table',
  //    which isn't offered for Metadata — StagePane's first-mode fallback
  //    lands on Entries). The right pane defaults to 'hex' (also valid for
  //    Metadata), so it wouldn't exercise the fallback. ────────────────────
  await page.locator('[data-testid="pane-dropdown-left"]').selectOption('metadata');
  await page.waitForTimeout(400);

  const entriesViewVisible = await page
    .locator('[data-testid="pane-left"] [data-testid="metadata-entries-view"]')
    .count();
  h.check('Metadata stage defaults to the Entries view', entriesViewVisible === 1, `count=${entriesViewVisible}`);

  // Select Metadata + Entries explicitly in the right pane for the rest of
  // the checks (both panes should agree — same worker payload).
  await page.locator('[data-testid="pane-dropdown-right"]').selectOption('metadata');
  await page.waitForTimeout(300);

  const entriesRadioPresent = await page
    .locator('[data-testid="pane-right"] [data-testid="view-mode-entries"]')
    .count();
  h.check('an "entries" view-mode radio exists in the right pane', entriesRadioPresent === 1);

  await page.locator('[data-testid="pane-right"] [data-testid="view-mode-entries"]').click();
  await page.waitForTimeout(300);

  // ── JSON serialization: rows present, no tag/type badge. ──────────────────
  await setSerialization(page, 'json');
  await shot(page, 'metadata-entries-json');

  const jsonRowCount = await page
    .locator('[data-testid="pane-right"] [data-testid^="metadata-entry-"]')
    .count();
  h.check('JSON mode: multiple entry rows render', jsonRowCount > 1, `count=${jsonRowCount}`);

  const schemaRowText = await page
    .locator('[data-testid="pane-right"] [data-testid="metadata-entry-schema"]')
    .innerText()
    .catch(() => '');
  h.check(
    'JSON mode: schema row is pretty-printed (multi-line JSON)',
    schemaRowText.includes('\n') && schemaRowText.includes('"name"'),
    schemaRowText.replace(/\n/g, ' ').slice(0, 160),
  );

  const jsonBadgeText = await page
    .locator('[data-testid="pane-right"] [data-testid="metadata-entry-metadata_format"]')
    .innerText()
    .catch(() => '');
  h.check(
    'JSON mode: no "tag N ·" badge on a row',
    !/tag \d+ ·/.test(jsonBadgeText),
    jsonBadgeText.replace(/\n/g, ' ').slice(0, 120),
  );

  // ── Binary serialization: rows present, registered key shows a numeric
  //    tag/type badge, custom-key row (added via UI) shows tag 0. ───────────
  await setSerialization(page, 'binary');
  await shot(page, 'metadata-entries-binary');

  const binaryRowCount = await page
    .locator('[data-testid="pane-right"] [data-testid^="metadata-entry-"]')
    .count();
  h.check('Binary mode: multiple entry rows render', binaryRowCount > 1, `count=${binaryRowCount}`);

  const schemaBadgeText = await page
    .locator('[data-testid="pane-right"] [data-testid="metadata-entry-schema"]')
    .innerText()
    .catch(() => '');
  h.check(
    'Binary mode: schema row shows its registered tag with a nonzero tag number',
    /tag [1-9]\d* · /.test(schemaBadgeText),
    schemaBadgeText.replace(/\n/g, ' ').slice(0, 120),
  );

  const binaryBadgeText = await page
    .locator('[data-testid="pane-right"] [data-testid="metadata-entry-metadata_format"]')
    .innerText()
    .catch(() => '');
  h.check(
    'Binary mode: registered key shows a numeric "tag N · type" badge',
    /tag \d+ · /.test(binaryBadgeText),
    binaryBadgeText.replace(/\n/g, ' ').slice(0, 120),
  );

  // ── Override lie: a custom entry keyed `shape` replaces the auto entry's
  //    value in place (spec §2, override-wins — no rename-on-collision
  //    protection). The custom-entries list is labeled "Custom / Overrides",
  //    the Entries view shows the corrupted value (not the real shape), and the
  //    read fails honestly. ────────────
  await setSerialization(page, 'json');
  await page.locator('[data-testid="sidebar-section-metadata"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="sidebar-section-metadata"] button', { hasText: /^\+ Entry$/ }).click();
  await page.waitForTimeout(200);
  const customKeyInputs = page.locator('[data-testid^="metadata-custom-key-"]');
  const newEntryIndex = (await customKeyInputs.count()) - 1;
  await customKeyInputs.nth(newEntryIndex).fill('shape');
  await page.locator('[data-testid="sidebar-section-metadata"] input[placeholder="value"]').nth(newEntryIndex).fill('not-json-shape');
  await page.waitForTimeout(300);
  await waitForPipelineIdle(page);

  const overridesLabelVisible = await page
    .locator('[data-testid="sidebar-section-metadata"]')
    .getByText('Custom / Overrides')
    .count();
  h.check('override lie: custom-entries list is labeled "Custom / Overrides"', overridesLabelVisible === 1);

  await shot(page, 'metadata-entries-override-lie');
  const overriddenShapeEntryText = await page
    .locator('[data-testid="pane-right"] [data-testid="metadata-entry-shape"]')
    .innerText()
    .catch(() => '');
  h.check(
    'override lie: Entries view shows the corrupted (non-JSON) shape value, not the real shape',
    overriddenShapeEntryText.includes('not-json-shape'),
    overriddenShapeEntryText.replace(/\n/g, ' ').slice(0, 120),
  );

  const overrideReadStatus = await page.locator('[data-testid="read-status"]').innerText().catch(() => '');
  h.check(
    'override lie: read fails honestly (no silent protection from the corrupted shape)',
    /Read failed/.test(overrideReadStatus) && !/File parsed successfully/.test(overrideReadStatus),
    overrideReadStatus.slice(0, 160).replace(/\n/g, ' '),
  );

  // Remove the override entry so it doesn't leak into the disabled check below.
  await page.locator(`button[aria-label="Remove metadata entry shape"]`).click();
  await page.waitForTimeout(200);
  await waitForPipelineIdle(page);

  // ── Disabled: shows the disabled empty state, not an empty table. ─────────
  await setIncludeMetadata(page, false);
  await shot(page, 'metadata-entries-disabled');
  const disabledText = await page
    .locator('[data-testid="pane-right"] [data-testid="metadata-entries-view"]')
    .innerText()
    .catch(() => '');
  h.check(
    'disabled: shows the "metadata is disabled" empty state',
    /metadata is disabled/.test(disabledText),
    disabledText.slice(0, 80),
  );

  await setIncludeMetadata(page, true);

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
