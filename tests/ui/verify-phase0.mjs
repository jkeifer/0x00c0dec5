import { chromium } from 'playwright';

const URL = 'http://localhost:5173/0x00c0dec5/';
const SCREEN_DIR = 'tests/ui/screenshots';

const results = [];
function record(check, pass, detail) {
  results.push({ check, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${check}${detail ? ' - ' + detail : ''}`);
}

async function newPage(browser, { fresh = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const issues = { console: [], pageerror: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      issues.console.push(`[console.${m.type()}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => issues.pageerror.push(`[pageerror] ${e.stack || e.message}`));
  await page.goto(URL);
  if (fresh) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  await page.waitForTimeout(1000);
  return { ctx, page, issues };
}

async function boundaryShown(page) {
  return (await page.locator('text=Something went wrong').count()) > 0;
}

async function bodyRendered(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  return text.length > 20;
}

async function bothPanesRender(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  // Both StagePane view-mode selectors ("Table","Grid","Flat") should appear twice (left+right)
  const tableCount = (text.match(/Table/g) || []).length;
  return tableCount >= 2;
}

async function main() {
  const browser = await chromium.launch();

  // ── Check 2: crash input — magic field ──────────────────────────────
  {
    const { page, issues } = await newPage(browser);
    const magicInput = page.locator('span:text("Magic Number") + input');
    await magicInput.waitFor({ state: 'visible', timeout: 5000 });

    await magicInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Meta+A');
    await magicInput.fill('');
    await page.keyboard.type('ZZZ');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SCREEN_DIR}/check2-zzz.png` });
    const blankAfterZZZ = !(await bodyRendered(page));
    const boundaryAfterZZZ = await boundaryShown(page);
    const bothPanesZZZ = await bothPanesRender(page);
    const warningTextZZZ = (await page.locator('text=Invalid hex').count()) > 0;
    console.log('  issues after ZZZ:', JSON.stringify(issues));

    await magicInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Meta+A');
    await magicInput.fill('');
    await page.keyboard.type('0');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SCREEN_DIR}/check2-single-zero.png` });
    const blankAfterZero = !(await bodyRendered(page));
    const boundaryAfterZero = await boundaryShown(page);
    const bothPanesZero = await bothPanesRender(page);
    const warningTextZero = (await page.locator('text=Invalid hex').count()) > 0;
    console.log('  issues after single 0:', JSON.stringify(issues));

    const pass =
      !blankAfterZZZ &&
      !boundaryAfterZZZ &&
      bothPanesZZZ &&
      warningTextZZZ &&
      !blankAfterZero &&
      !boundaryAfterZero &&
      bothPanesZero &&
      warningTextZero &&
      issues.pageerror.length === 0;

    record(
      'Check 2: crash input - magic field',
      pass,
      `blankZZZ=${blankAfterZZZ} boundaryZZZ=${boundaryAfterZZZ} bothPanesZZZ=${bothPanesZZZ} warnZZZ=${warningTextZZZ}; blankZero=${blankAfterZero} boundaryZero=${boundaryAfterZero} bothPanesZero=${bothPanesZero} warnZero=${warningTextZero}; pageerrors=${issues.pageerror.length}`,
    );
    await page.context().close();
  }

  // ── Check 3: legacy v1 state ─────────────────────────────────────────
  {
    const { page, issues } = await newPage(browser, { fresh: true });
    const v1State = {
      variables: [{ id: 'a', name: 'a', dtype: 'float32', color: '#e06c75' }],
      shape: [32],
      chunkShape: [32],
      interleaving: 'column',
      fieldPipelines: {
        a: [
          { codec: 'scale-offset', params: {} },
          { codec: 'delta', params: {} },
        ],
      },
      chunkPipeline: [],
      metadata: { customEntries: [], serialization: 'json' },
      write: {
        magicNumber: '00C0DEC5',
        partitioning: 'single',
        metadataPlacement: 'header',
        chunkOrder: 'row-major',
      },
    };
    await page.evaluate((s) => {
      localStorage.setItem('0x00c0dec5-state-tabular', JSON.stringify(s));
    }, v1State);
    await page.reload();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SCREEN_DIR}/check3-legacy-v1.png` });

    const rendered = await bodyRendered(page);
    const boundary = await boundaryShown(page);
    const varAInput = page.locator('input[placeholder="name"][value="a"]');
    const varAVisible = (await varAInput.count()) > 0;
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const hasDelta = /Delta/.test(bodyText);
    const hasScaleOffset = /scale-offset|Scale.?Offset/i.test(bodyText);
    console.log('  issues legacy v1:', JSON.stringify(issues));

    const pass = rendered && !boundary && varAVisible && hasDelta && !hasScaleOffset;
    record(
      'Check 3: legacy v1 state',
      pass,
      `rendered=${rendered} boundary=${boundary} varAVisible=${varAVisible} hasDelta=${hasDelta} hasScaleOffset=${hasScaleOffset} pageerrors=${issues.pageerror.length}`,
    );
    await page.context().close();
  }

  // ── Check 4: corrupt state (garbage fields, then invalid JSON) ───────
  {
    const { page, issues } = await newPage(browser, { fresh: true });
    await page.evaluate(() => {
      localStorage.setItem(
        '0x00c0dec5-state-tabular',
        JSON.stringify({ variables: 'garbage', shape: [0, -1] }),
      );
    });
    await page.reload();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SCREEN_DIR}/check4-garbage-fields.png` });
    const rendered1 = await bodyRendered(page);
    const boundary1 = await boundaryShown(page);
    const bodyText1 = await page.locator('body').innerText().catch(() => '');
    const starterVars1 = ['temperature', 'pressure', 'humidity'].every((n) => bodyText1.includes(n));
    console.log('  issues garbage-fields:', JSON.stringify(issues));

    issues.console.length = 0;
    issues.pageerror.length = 0;
    await page.evaluate(() => {
      localStorage.setItem('0x00c0dec5-state-tabular', 'not json at all{{{');
    });
    await page.reload();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SCREEN_DIR}/check4-not-json.png` });
    const rendered2 = await bodyRendered(page);
    const boundary2 = await boundaryShown(page);
    const bodyText2 = await page.locator('body').innerText().catch(() => '');
    const starterVars2 = ['temperature', 'pressure', 'humidity'].every((n) => bodyText2.includes(n));
    console.log('  issues not-json:', JSON.stringify(issues));

    const pass = rendered1 && !boundary1 && starterVars1 && rendered2 && !boundary2 && starterVars2;
    record(
      'Check 4: corrupt state (garbage fields + invalid JSON)',
      pass,
      `garbage: rendered=${rendered1} boundary=${boundary1} starters=${starterVars1}; notjson: rendered=${rendered2} boundary=${boundary2} starters=${starterVars2}`,
    );
    await page.context().close();
  }

  // ── Check 5: chunk-shape zero ─────────────────────────────────────────
  {
    const { page, issues } = await newPage(browser, { fresh: true });
    const zeroChunkState = {
      dataModel: 'tabular',
      variables: [
        { id: 'a', name: 'temperature', color: '#e06c75', logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1 }, typeAssignment: { storageDtype: 'float32' } },
      ],
      shape: [32],
      chunkShape: [0],
      interleaving: 'column',
      fieldPipelines: {},
      chunkPipeline: [],
      metadata: { customEntries: [], serialization: 'json' },
      write: {
        magicNumber: '00C0DEC5',
        partitioning: 'single',
        metadataPlacement: 'header',
        chunkOrder: 'row-major',
        includeMetadata: true,
      },
      ui: {},
    };
    await page.evaluate((s) => {
      localStorage.setItem('0x00c0dec5-state-tabular', JSON.stringify(s));
    }, zeroChunkState);

    let navErr = null;
    try {
      await page.goto(URL, { timeout: 10000 });
      await page.reload({ timeout: 10000 });
    } catch (e) {
      navErr = e.message;
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREEN_DIR}/check5-chunkshape-zero.png` });

    const rendered = await bodyRendered(page);
    const boundary = await boundaryShown(page);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.log('  issues chunkshape-zero:', JSON.stringify(issues));
    console.log('  nav error:', navErr);
    // Look for "Grid:" / "chunk" line indicating a clamped, valid (nonzero) chunk shape rendered
    const chunkGridMatch = bodyText.match(/Grid:\s*(\d+)/);
    const chunkClamped = chunkGridMatch ? Number(chunkGridMatch[1]) > 0 : false;

    const pass = navErr === null && rendered && !boundary && chunkClamped;
    record(
      'Check 5: chunk-shape zero',
      pass,
      `navErr=${navErr} rendered=${rendered} boundary=${boundary} chunkGridMatch=${chunkGridMatch ? chunkGridMatch[0] : 'none'}`,
    );
    await page.context().close();
  }

  // ── Check 6: ErrorBoundary sanity (source check done separately) ─────
  // Verified above that boundary text never appeared in checks 2-5.
  const boundaryNeverShown = results
    .filter((r) => r.check.startsWith('Check 2') || r.check.startsWith('Check 3') || r.check.startsWith('Check 4') || r.check.startsWith('Check 5'))
    .every((r) => !r.detail.includes('boundary=true') && !r.detail.includes('boundaryZZZ=true') && !r.detail.includes('boundaryZero=true') && !r.detail.includes('boundary1=true') && !r.detail.includes('boundary2=true'));
  record('Check 6: ErrorBoundary fallback never shown across all inputs', boundaryNeverShown);

  await browser.close();

  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.check}`);
  }
  const anyFail = results.some((r) => !r.pass);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
