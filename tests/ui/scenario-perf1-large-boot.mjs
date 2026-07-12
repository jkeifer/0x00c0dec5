// Regression scenario: PERF-1 (remediation-plan.md) — the fresh-boot pipeline
// stall above ~8.37M total values, plus the boot-failure UX hole it exposed.
//
// Root cause was the worker's result postMessage: a structured clone of the
// full PipelineResult — dominated by materialized per-element chunkRegions —
// threw "Data cannot be cloned, out of memory" above the cliff, and the
// ok:false first compute left the "starting…" screen up forever. Fixed by the
// stage-delta protocol (transfer + evict-on-send, src/worker/protocol.ts /
// engine/pipelineCompute.ts), deleting PipelineStage.chunkRegions, and the
// BootScreen error branch (App.tsx).
//
// Checks:
//   1. A fresh boot seeded at [2047,2047] x 2 vars (8,380,418 values — the
//      first shape past the old cliff) settles well within the old timeout.
//   2. No page errors while doing so.
//   3. A forced ok:false FIRST compute renders pipeline-boot-error (with the
//      error text) instead of the infinite "starting…" screen.
//
// Run: node tests/ui/scenario-perf1-large-boot.mjs   (dev server must be running)

import { chromium } from 'playwright';
import { newContext, shot, createHarness, seedStateAndReload, waitForPipelineIdle } from './scenario-helpers.mjs';

const h = createHarness('scenario-perf1-large-boot');

function arrayState(shape) {
  return {
    dataModel: 'array',
    shape,
    chunkShape: shape.slice(),
    interleaving: 'column',
    variables: [
      { id: 'temp', name: 'temp', color: '#e06c75',
        logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'smooth' },
        typeAssignment: { storageDtype: 'float32' } },
      { id: 'press', name: 'press', color: '#61afef',
        logicalType: { type: 'decimal', min: 900, max: 1100, decimalPlaces: 1, generation: 'sorted' },
        typeAssignment: { storageDtype: 'float32' } },
    ],
    fieldPipelines: { temp: [], press: [] },
    chunkPipeline: [],
    metadata: { customEntries: [], serialization: 'json', include: { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true } },
    write: { includeMetadata: false, magicNumber: '00C0DEC5', partitioning: 'single', metadataPlacement: 'header', chunkOrder: 'row-major', footerLocator: 'trailer' },
    ui: { leftPaneStage: 'values', rightPaneStage: 'values', leftPaneView: 'grid', rightPaneView: 'hex', showDiff: false },
  };
}

async function main() {
  const browser = await chromium.launch();

  // ── Check 1+2: fresh boot past the old cliff settles ─────────────────────
  {
    const { ctx, page, issues } = await newContext(browser);
    await seedStateAndReload(page, {
      '0x00c0dec5-active-model': 'array',
      '0x00c0dec5-state-array': arrayState([2047, 2047]),
    });
    let settled = true;
    const t0 = Date.now();
    await waitForPipelineIdle(page, 60_000).catch(() => { settled = false; });
    h.check(
      'fresh boot at [2047,2047]x2 vars (8,380,418 values) settles within 60s',
      settled,
      settled ? `settled in ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'still on pipeline-booting after 60s',
    );
    h.check('no page errors during the large boot', issues.pageerror.length === 0, issues.pageerror.slice(0, 3).join(' | '));
    await shot(page, 'perf1-large-boot');
    await ctx.close();
  }

  // ── Check 3: forced ok:false first compute surfaces the error ────────────
  {
    const { ctx, page } = await newContext(browser);
    // Patch Worker on the incoming document: rewrite every result message to
    // ok:false before the app's client sees it — simulates a boot-time
    // compute/serialization failure regardless of engine health.
    await page.context().addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        addEventListener(type, fn) {
          if (type !== 'message') return super.addEventListener(type, fn);
          super.addEventListener('message', (e) => {
            const d = e.data;
            if (d?.kind === 'result') {
              fn({ data: { kind: 'result', id: d.id, ok: false, error: 'PROBE: forced boot failure' } });
            } else {
              fn(e);
            }
          });
        }
      };
    });
    await seedStateAndReload(page, {
      '0x00c0dec5-active-model': 'array',
      '0x00c0dec5-state-array': arrayState([8, 8]),
    });
    const errorEl = page.locator('[data-testid="pipeline-boot-error"]');
    const appeared = await errorEl.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
    h.check('a failed FIRST compute shows pipeline-boot-error instead of the infinite booting screen', appeared);
    if (appeared) {
      const text = await errorEl.innerText();
      h.check('the boot error surfaces the worker error text', text.includes('PROBE: forced boot failure'), text);
    }
    await shot(page, 'perf1-boot-error');
    await ctx.close();
  }

  await browser.close();
  h.finish();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
