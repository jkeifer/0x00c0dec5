import { chromium } from 'playwright';

async function testChunkTracking() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(2000);

  // Find stage selectors (the ones with Values/Linearized/Encoded/Metadata/Write)
  const selects = await page.locator('select').all();
  let leftStageIdx = -1, rightStageIdx = -1;
  for (let i = 0; i < selects.length; i++) {
    const options = await selects[i].locator('option').allTextContents();
    if (options.includes('Values') && options.includes('Write')) {
      if (leftStageIdx < 0) leftStageIdx = i;
      else rightStageIdx = i;
    }
  }
  console.log(`Stage selectors: left=${leftStageIdx}, right=${rightStageIdx}`);

  // Set left=Values(0), right=Write(4)
  await selects[leftStageIdx].selectOption('0');
  await selects[rightStageIdx].selectOption('4');
  await page.waitForTimeout(500);

  // Find the divider between panes
  const dividerX = await page.evaluate(() => {
    const handles = document.querySelectorAll('[data-resize-handle]');
    let maxX = 0;
    handles.forEach(h => {
      const rect = h.getBoundingClientRect();
      if (rect.x > maxX) maxX = rect.x;
    });
    return maxX || 1000;
  });
  console.log(`Pane divider at x=${dividerX}`);

  // ---- TEST A: Table cell hover → Write hex highlighting ----
  console.log('\n=== TEST A: Table cell hover → Write hex highlighting ===');

  // Table cells are <div> elements with onMouseEnter handlers
  // They contain numeric text values. Find them in the left pane.
  const tableCells = await page.evaluate((dx: number) => {
    // Find divs that look like table data cells in the left pane
    const allDivs = document.querySelectorAll('div');
    const cells: { text: string; x: number; y: number; w: number; h: number; color: string }[] = [];
    const numPattern = /^-?\d+\.?\d*(e[+-]?\d+)?$/i;

    allDivs.forEach(div => {
      const rect = div.getBoundingClientRect();
      // Only left pane, reasonable cell dimensions
      if (rect.x >= dx || rect.width < 30 || rect.height < 15 || rect.height > 30) return;

      const text = div.textContent?.trim();
      if (!text || !numPattern.test(text)) return;

      // Check this is a leaf div (no child divs)
      if (div.querySelector('div')) return;

      cells.push({
        text,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        color: getComputedStyle(div).color,
      });
    });
    return cells.slice(0, 30);
  }, dividerX);

  console.log(`Found ${tableCells.length} table cells`);
  if (tableCells.length > 0) {
    console.log('First 5:', tableCells.slice(0, 5).map(c => `"${c.text}" at (${c.x},${c.y})`));
  }

  for (let i = 0; i < Math.min(12, tableCells.length); i++) {
    const cell = tableCells[i];
    await page.mouse.move(cell.x + cell.w / 2, cell.y + cell.h / 2);
    await page.waitForTimeout(200);

    const result = await page.evaluate((dx: number) => {
      let hoverText = '';
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        if (div.style.height === '24px' && div.style.fontFamily) {
          hoverText = div.textContent || '';
          break;
        }
      }

      const allSpans = document.querySelectorAll('span');
      const hexPattern = /^[0-9A-Fa-f]{2}$/;
      let rightHighlightCount = 0;
      allSpans.forEach(span => {
        const text = span.textContent?.trim();
        if (text && hexPattern.test(text) && span.style.cursor === 'default') {
          const rect = span.getBoundingClientRect();
          if (rect.x >= dx) {
            const bg = span.style.backgroundColor;
            if (bg && bg.includes('0.1')) rightHighlightCount++;
          }
        }
      });

      return { hoverText, rightHighlightCount };
    }, dividerX);

    console.log(`  Cell ${i} "${cell.text}": hover="${result.hoverText}" | write-highlighted=${result.rightHighlightCount}`);
  }

  await page.screenshot({ path: 'tests/ui/screenshots/test-a-table-hover.png', fullPage: false });

  // ---- TEST B: Switch to Hex view, hover Values bytes → Write highlights ----
  console.log('\n=== TEST B: Values Hex → Write hex cross-pane ===');

  // Radio buttons are <button> elements, click "Hex" in the left pane
  const hexButton = page.locator('button').filter({ hasText: /^Hex$/ }).first();
  await hexButton.click();
  await page.waitForTimeout(500);

  await page.screenshot({ path: 'tests/ui/screenshots/test-b-hex-hex.png', fullPage: false });

  const leftHexBytes = await page.evaluate((dx: number) => {
    const allSpans = document.querySelectorAll('span');
    const hexPattern = /^[0-9A-Fa-f]{2}$/;
    const bytes: { text: string; x: number; y: number; w: number; h: number; color: string }[] = [];
    allSpans.forEach(span => {
      const text = span.textContent?.trim();
      if (text && hexPattern.test(text) && span.style.cursor === 'default') {
        const rect = span.getBoundingClientRect();
        if (rect.x < dx && rect.width > 0) {
          bytes.push({
            text,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            color: span.style.color,
          });
        }
      }
    });
    return bytes.slice(0, 30);
  }, dividerX);

  console.log(`Left (Values hex): ${leftHexBytes.length} bytes`);
  if (leftHexBytes.length > 0) {
    console.log('First 8:', leftHexBytes.slice(0, 8).map(b => `${b.text} c=${b.color}`));
  }

  for (let i = 0; i < Math.min(16, leftHexBytes.length); i++) {
    const byte = leftHexBytes[i];
    await page.mouse.move(byte.x + byte.w / 2, byte.y + byte.h / 2);
    await page.waitForTimeout(200);

    const result = await page.evaluate((dx: number) => {
      let hoverText = '';
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        if (div.style.height === '24px' && div.style.fontFamily) {
          hoverText = div.textContent || '';
          break;
        }
      }

      const allSpans = document.querySelectorAll('span');
      const hexPattern = /^[0-9A-Fa-f]{2}$/;
      let rightHighlightCount = 0;
      const highlighted: string[] = [];
      allSpans.forEach(span => {
        const text = span.textContent?.trim();
        if (text && hexPattern.test(text) && span.style.cursor === 'default') {
          const rect = span.getBoundingClientRect();
          if (rect.x >= dx) {
            const bg = span.style.backgroundColor;
            if (bg && bg.includes('0.1')) {
              rightHighlightCount++;
              highlighted.push(text);
            }
          }
        }
      });

      return { hoverText, rightHighlightCount, highlighted: highlighted.slice(0, 10) };
    }, dividerX);

    console.log(`  L-Byte ${i} "${byte.text}" (c=${byte.color}): hover="${result.hoverText}" | write-highlighted=${result.rightHighlightCount} [${result.highlighted.join(' ')}]`);
  }

  await page.screenshot({ path: 'tests/ui/screenshots/test-b-hover.png', fullPage: false });

  // ---- TEST C: Hover on Write data bytes → Values highlights ----
  console.log('\n=== TEST C: Write data bytes → Values highlights ===');

  // Find colored bytes (data) in right pane - they have non-gray colors
  const rightColoredBytes = await page.evaluate((dx: number) => {
    const allSpans = document.querySelectorAll('span');
    const hexPattern = /^[0-9A-Fa-f]{2}$/;
    const bytes: { text: string; x: number; y: number; w: number; h: number; color: string }[] = [];
    allSpans.forEach(span => {
      const text = span.textContent?.trim();
      if (text && hexPattern.test(text) && span.style.cursor === 'default') {
        const rect = span.getBoundingClientRect();
        if (rect.x >= dx && rect.width > 0) {
          const color = span.style.color;
          // Non-gray means data bytes (variables have assigned colors)
          if (color && !color.includes('139, 148, 158')) {
            bytes.push({
              text,
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              color,
            });
          }
        }
      }
    });
    return bytes.slice(0, 30);
  }, dividerX);

  console.log(`Right pane colored (data) bytes visible: ${rightColoredBytes.length}`);

  if (rightColoredBytes.length === 0) {
    console.log('No data bytes visible, scrolling right pane to data area...');
    // Find any hex byte in right pane and scroll down past metadata
    const rightAnyByte = await page.evaluate((dx: number) => {
      const allSpans = document.querySelectorAll('span');
      const hexPattern = /^[0-9A-Fa-f]{2}$/;
      for (const span of allSpans) {
        const text = span.textContent?.trim();
        if (text && hexPattern.test(text) && span.style.cursor === 'default') {
          const rect = span.getBoundingClientRect();
          if (rect.x >= dx) return { x: Math.round(rect.x + 50), y: Math.round(rect.y + 50) };
        }
      }
      return null;
    }, dividerX);

    if (rightAnyByte) {
      await page.mouse.move(rightAnyByte.x, rightAnyByte.y);
      // Scroll down significantly to get past metadata (~400 bytes = ~25 rows)
      for (let s = 0; s < 5; s++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(300);

      // Re-check for colored bytes
      const scrolledBytes = await page.evaluate((dx: number) => {
        const allSpans = document.querySelectorAll('span');
        const hexPattern = /^[0-9A-Fa-f]{2}$/;
        const bytes: { text: string; x: number; y: number; w: number; h: number; color: string }[] = [];
        allSpans.forEach(span => {
          const text = span.textContent?.trim();
          if (text && hexPattern.test(text) && span.style.cursor === 'default') {
            const rect = span.getBoundingClientRect();
            if (rect.x >= dx && rect.width > 0) {
              const color = span.style.color;
              if (color && !color.includes('139, 148, 158')) {
                bytes.push({ text, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), color });
              }
            }
          }
        });
        return bytes.slice(0, 30);
      }, dividerX);

      console.log(`After scrolling: ${scrolledBytes.length} colored data bytes visible`);
      if (scrolledBytes.length > 0) {
        console.log('First 5:', scrolledBytes.slice(0, 5).map(b => `${b.text} c=${b.color}`));

        for (let i = 0; i < Math.min(16, scrolledBytes.length); i++) {
          const byte = scrolledBytes[i];
          await page.mouse.move(byte.x + byte.w / 2, byte.y + byte.h / 2);
          await page.waitForTimeout(200);

          const result = await page.evaluate((dx: number) => {
            let hoverText = '';
            const allDivs = document.querySelectorAll('div');
            for (const div of allDivs) {
              if (div.style.height === '24px' && div.style.fontFamily) {
                hoverText = div.textContent || '';
                break;
              }
            }

            let leftHighlightCount = 0;
            const allSpans = document.querySelectorAll('span');
            const hexPattern = /^[0-9A-Fa-f]{2}$/;
            allSpans.forEach(span => {
              const text = span.textContent?.trim();
              if (text && hexPattern.test(text) && span.style.cursor === 'default') {
                const rect = span.getBoundingClientRect();
                if (rect.x < dx) {
                  const bg = span.style.backgroundColor;
                  if (bg && bg.includes('0.1')) leftHighlightCount++;
                }
              }
            });

            return { hoverText, leftHighlightCount };
          }, dividerX);

          console.log(`  R-Data ${i} "${byte.text}" (c=${byte.color}): hover="${result.hoverText}" | values-highlighted=${result.leftHighlightCount}`);
        }
      }
    }
  } else {
    console.log('First 5:', rightColoredBytes.slice(0, 5).map(b => `${b.text} c=${b.color}`));
    for (let i = 0; i < Math.min(16, rightColoredBytes.length); i++) {
      const byte = rightColoredBytes[i];
      await page.mouse.move(byte.x + byte.w / 2, byte.y + byte.h / 2);
      await page.waitForTimeout(200);

      const result = await page.evaluate((dx: number) => {
        let hoverText = '';
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
          if (div.style.height === '24px' && div.style.fontFamily) {
            hoverText = div.textContent || '';
            break;
          }
        }

        let leftHighlightCount = 0;
        const allSpans = document.querySelectorAll('span');
        const hexPattern = /^[0-9A-Fa-f]{2}$/;
        allSpans.forEach(span => {
          const text = span.textContent?.trim();
          if (text && hexPattern.test(text) && span.style.cursor === 'default') {
            const rect = span.getBoundingClientRect();
            if (rect.x < dx) {
              const bg = span.style.backgroundColor;
              if (bg && bg.includes('0.1')) leftHighlightCount++;
            }
          }
        });

        return { hoverText, leftHighlightCount };
      }, dividerX);

      console.log(`  R-Data ${i} "${byte.text}" (c=${byte.color}): hover="${result.hoverText}" | values-highlighted=${result.leftHighlightCount}`);
    }
  }

  await page.screenshot({ path: 'tests/ui/screenshots/test-c-write-hover.png', fullPage: false });

  // ---- TEST D: HoverBar Write stage presence ----
  console.log('\n=== TEST D: HoverBar shows Write stage? ===');

  // Go back to top of left pane
  const hexButton2 = page.locator('button').filter({ hasText: /^Hex$/ }).first();
  await hexButton2.click();
  await page.waitForTimeout(300);

  // Move to a left pane byte (scroll back to top)
  // Just hover on the first available left hex byte
  const firstLeftByte = await page.evaluate((dx: number) => {
    const allSpans = document.querySelectorAll('span');
    const hexPattern = /^[0-9A-Fa-f]{2}$/;
    for (const span of allSpans) {
      const text = span.textContent?.trim();
      if (text && hexPattern.test(text) && span.style.cursor === 'default') {
        const rect = span.getBoundingClientRect();
        if (rect.x < dx && rect.width > 0) {
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
    }
    return null;
  }, dividerX);

  if (firstLeftByte) {
    await page.mouse.move(firstLeftByte.x, firstLeftByte.y);
    await page.waitForTimeout(500);

    const hoverDetail = await page.evaluate(() => {
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        if (div.style.height === '24px' && div.style.fontFamily) {
          const text = div.textContent || '';
          return {
            fullText: text,
            hasWrite: text.includes('Write'),
            hasValues: text.includes('Values'),
            hasLinearized: text.includes('Linearized'),
            hasEncoded: text.includes('Encoded'),
            hasMetadata: text.includes('Metadata'),
          };
        }
      }
      return null;
    });
    console.log('HoverBar detail:', JSON.stringify(hoverDetail, null, 2));
  }

  // ---- TEST E: Values vs Linearized cross-pane (known working?) ----
  console.log('\n=== TEST E: Values hex vs Linearized hex ===');
  await selects[rightStageIdx].selectOption('1');
  await page.waitForTimeout(500);

  const leftBytes3 = await page.evaluate((dx: number) => {
    const allSpans = document.querySelectorAll('span');
    const hexPattern = /^[0-9A-Fa-f]{2}$/;
    const bytes: { text: string; x: number; y: number; w: number; h: number; color: string }[] = [];
    allSpans.forEach(span => {
      const text = span.textContent?.trim();
      if (text && hexPattern.test(text) && span.style.cursor === 'default') {
        const rect = span.getBoundingClientRect();
        if (rect.x < dx && rect.width > 0) {
          bytes.push({ text, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), color: span.style.color });
        }
      }
    });
    return bytes.slice(0, 16);
  }, dividerX);

  for (let i = 0; i < Math.min(8, leftBytes3.length); i++) {
    const byte = leftBytes3[i];
    await page.mouse.move(byte.x + byte.w / 2, byte.y + byte.h / 2);
    await page.waitForTimeout(200);

    const result = await page.evaluate((dx: number) => {
      let hoverText = '';
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        if (div.style.height === '24px' && div.style.fontFamily) {
          hoverText = div.textContent || '';
          break;
        }
      }

      let rightHighlightCount = 0;
      const allSpans = document.querySelectorAll('span');
      const hexPattern = /^[0-9A-Fa-f]{2}$/;
      allSpans.forEach(span => {
        const text = span.textContent?.trim();
        if (text && hexPattern.test(text) && span.style.cursor === 'default') {
          const rect = span.getBoundingClientRect();
          if (rect.x >= dx) {
            const bg = span.style.backgroundColor;
            if (bg && bg.includes('0.1')) rightHighlightCount++;
          }
        }
      });

      return { hoverText, rightHighlightCount };
    }, dividerX);

    console.log(`  L-Byte ${i} "${byte.text}": hover="${result.hoverText}" | linearized-highlighted=${result.rightHighlightCount}`);
  }

  // ---- TEST F: Values vs Encoded ----
  console.log('\n=== TEST F: Values hex vs Encoded hex ===');
  await selects[rightStageIdx].selectOption('2');
  await page.waitForTimeout(500);

  for (let i = 0; i < Math.min(8, leftBytes3.length); i++) {
    const byte = leftBytes3[i];
    await page.mouse.move(byte.x + byte.w / 2, byte.y + byte.h / 2);
    await page.waitForTimeout(200);

    const result = await page.evaluate((dx: number) => {
      let hoverText = '';
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        if (div.style.height === '24px' && div.style.fontFamily) {
          hoverText = div.textContent || '';
          break;
        }
      }

      let rightHighlightCount = 0;
      const allSpans = document.querySelectorAll('span');
      const hexPattern = /^[0-9A-Fa-f]{2}$/;
      allSpans.forEach(span => {
        const text = span.textContent?.trim();
        if (text && hexPattern.test(text) && span.style.cursor === 'default') {
          const rect = span.getBoundingClientRect();
          if (rect.x >= dx) {
            const bg = span.style.backgroundColor;
            if (bg && bg.includes('0.1')) rightHighlightCount++;
          }
        }
      });

      return { hoverText, rightHighlightCount };
    }, dividerX);

    console.log(`  L-Byte ${i} "${byte.text}": hover="${result.hoverText}" | encoded-highlighted=${result.rightHighlightCount}`);
  }

  console.log('\n=== ALL TESTS COMPLETE ===');
  await browser.close();
}

testChunkTracking().catch(console.error);
