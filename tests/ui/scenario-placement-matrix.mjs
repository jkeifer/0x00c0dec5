// Regression scenario: metadata placement x serialization matrix.
//
// Drives the Write sidebar's "Include Metadata" / "Metadata Placement" controls and
// the Metadata sidebar's JSON/Binary serialization toggle, then asserts on
// [data-testid="read-status"].
//
// KNOWN-FAIL RP-1 (docs/remediation-plan.md Part 1, "Read-path feature gaps"):
// binary metadata + footer placement cannot be read back — tryParseEmbeddedMetadata's
// footer branch only looks for JSON braces, so read fails with a misleading
// "no metadata" message even though metadata IS in the file. Fixed by Phase 2
// (task 2.3/2.4, the footer-locator work). This scenario asserts the failure
// reproduces today; if it ever starts passing, that's reported loudly as UNEXPECTED
// since it means Phase 2 landed and this scenario's expectation should flip to PASS.
//
// Run: node tests/ui/scenario-placement-matrix.mjs   (dev server must be running)

import { launch, shot, createHarness } from './scenario-helpers.mjs';

const h = createHarness('scenario-placement-matrix');

const PLACEMENTS = ['header', 'footer', 'sidecar'];
const SERIALIZATIONS = ['json', 'binary'];
const PLACEMENT_LABEL = { header: 'Header', footer: 'Footer', sidecar: 'Sidecar' };
const SERIALIZATION_LABEL = { json: 'JSON', binary: 'Binary' };

async function readStatusText(page) {
  return page.locator('[data-testid="read-status"]').innerText().catch(() => '');
}

async function isReadSuccess(page) {
  const text = await readStatusText(page);
  return /File parsed successfully/.test(text);
}

async function setIncludeMetadata(page, on) {
  await page
    .locator('[data-testid="include-metadata-toggle"] button', { hasText: on ? /^Yes$/ : /^No$/ })
    .click();
  await page.waitForTimeout(500);
}

async function setPlacement(page, placement) {
  await page
    .locator('[data-testid="sidebar-section-write"] button', { hasText: new RegExp(`^${PLACEMENT_LABEL[placement]}$`) })
    .click();
  await page.waitForTimeout(500);
}

async function setSerialization(page, serialization) {
  await page
    .locator('[data-testid="sidebar-section-metadata"] button', { hasText: new RegExp(`^${SERIALIZATION_LABEL[serialization]}$`) })
    .click();
  await page.waitForTimeout(500);
}

async function main() {
  const { browser, page } = await launch();

  // Turn on include-metadata first — the matrix is meaningless without it.
  await setIncludeMetadata(page, true);
  const includeOnText = await readStatusText(page);
  h.check(
    'include-metadata ON with default (header/json) reads successfully',
    /File parsed successfully/.test(includeOnText),
    includeOnText.slice(0, 120).replace(/\n/g, ' '),
  );

  for (const serialization of SERIALIZATIONS) {
    await setSerialization(page, serialization);
    for (const placement of PLACEMENTS) {
      await setPlacement(page, placement);
      await page.waitForTimeout(200);
      const text = await readStatusText(page);
      const success = /File parsed successfully/.test(text);
      const label = `placement=${placement} serialization=${serialization}`;
      await shot(page, `placement-matrix-${placement}-${serialization}`);

      if (placement === 'footer' && serialization === 'binary') {
        // KNOWN-FAIL RP-1: binary + footer cannot be located by the reader today.
        h.knownFail(
          `${label} → read succeeds`,
          success,
          success
            ? 'read unexpectedly succeeded'
            : `read failed as expected: ${text.slice(0, 160).replace(/\n/g, ' ')}`,
          'RP-1 (fix: Phase 2)',
        );
      } else {
        h.check(`${label} → read succeeds`, success, text.slice(0, 120).replace(/\n/g, ' '));
      }
    }
  }

  // Reset to header/json for a clean pedagogical-failure check below.
  await setSerialization(page, 'json');
  await setPlacement(page, 'header');
  await page.waitForTimeout(200);

  // include-metadata OFF → read should fail (the pedagogical path: nothing in the
  // file describes its own layout, so the reader has nothing to work with).
  await setIncludeMetadata(page, false);
  await page.waitForTimeout(300);
  const offText = await readStatusText(page);
  await shot(page, 'placement-matrix-include-metadata-off');
  h.check(
    'include-metadata OFF → read fails (pedagogical: no self-description in file)',
    /Read failed/.test(offText) && !/File parsed successfully/.test(offText),
    offText.slice(0, 160).replace(/\n/g, ' '),
  );

  await browser.close();
  h.finish();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
