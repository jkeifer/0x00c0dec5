# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

This is **0x00C0DEC5**, an interactive web tool for learning how data file formats are constructed. See `docs/design.md` for the full specification and `docs/extension-read-step.md` for the read/round-trip extension.

Tech stack: React + TypeScript + Vite.

## Development Workflow

### Starting the dev server

```bash
npm run dev
```

Vite runs on `http://localhost:5173` by default.

### Running tests

```bash
npx vitest run          # single run
npx vitest              # watch mode
```

### Build order

Follow the Implementation Order in `docs/design.md`. The cardinal rule: **the engine layer (`src/engine/`) must be tested and correct before building UI components.** The prototyping phase of this project failed repeatedly because UI was built on broken data logic. Do not repeat this mistake.

When implementing a new engine module:
1. Write the module
2. Write tests for the module
3. Run the tests and fix failures
4. Only then move on

When implementing a new UI component:
1. Build the component
2. Test it visually using Playwright (see below)
3. Fix visual/interaction bugs before moving on

## Testing Strategy

### Engine tests (vitest)

All files in `src/engine/` are pure functions operating on typed arrays and plain objects. They should have thorough unit tests covering:

- **Dtype operations**: write/read roundtrips for every dtype, edge cases (min/max values, NaN for floats, zero)
- **Codec roundtrips**: for each codec, `decode(encode(input, dtype, params), dtype, params)` should produce the expected output. Lossless codecs should roundtrip exactly. Lossy codecs (bitround, scale/offset across float↔int) should be tested for expected error bounds.
- **Chunking**: verify chunk counts, chunk boundaries, element assignment for both data models and multiple shapes
- **Linearization**: verify byte order changes between row and column interleaving
- **Tracing**: verify traceIds are preserved through non-size-changing transforms and degrade to chunk-level after entropy codecs
- **Metadata serialization**: JSON and binary roundtrips
- **Write step**: verify file assembly (magic number position, metadata placement, chunk ordering)

### UI testing (Playwright)

For debugging UI bugs and verifying interactive behavior, use Playwright with a headless Chromium browser.

#### Setup

```bash
npx playwright install chromium
```

#### Writing UI test scripts

Create test scripts in `tests/ui/` that:

1. Start or connect to the Vite dev server
2. Navigate to the app
3. Interact with the UI (click, hover, type, select)
4. Take screenshots to verify visual state
5. Assert on DOM content where possible

Example pattern:

```typescript
import { chromium } from 'playwright';

async function testHoverLinking() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173');

  // Wait for the app to render
  await page.waitForSelector('[data-testid="table-view"]');

  // Hover over a table cell
  const cell = page.locator('[data-testid="table-cell-temperature-5"]');
  await cell.hover();

  // Screenshot to verify hex view highlighting
  await page.screenshot({ path: 'tests/ui/screenshots/hover-linking.png', fullPage: true });

  // Check that the hover bar shows the expected value
  const hoverBar = page.locator('[data-testid="hover-bar"]');
  const text = await hoverBar.textContent();
  console.log('Hover bar:', text);

  // Verify hex view has highlighted bytes
  const highlightedBytes = page.locator('[data-testid="hex-byte"].highlighted');
  const count = await highlightedBytes.count();
  console.log(`Highlighted bytes: ${count}`);

  await browser.close();
}

testHoverLinking().catch(console.error);
```

#### When to use Playwright

- **After building any viewer component** (HexView, TableView, GridView, FlatView): verify rendering, virtual scrolling, and hover behavior
- **After wiring up cross-pane interactions**: verify hover in one pane highlights in the other
- **After building the pipeline strip**: verify stage nodes render with correct stats
- **After implementing resizable panels**: verify drag handles work and don't break layout
- **When a bug is reported or suspected**: write a Playwright script that reproduces the scenario, screenshot the result, inspect the DOM

#### Data-testid conventions

Add `data-testid` attributes to key interactive elements:

- `table-view`, `hex-view`, `grid-view`, `flat-view` — viewer containers
- `table-cell-{variable}-{index}` — individual table cells
- `hex-byte-{offset}` — individual hex bytes
- `hover-bar` — the cross-stage hover info bar
- `pipeline-stage-{index}` — pipeline strip nodes
- `pane-left`, `pane-right` — comparison pane containers
- `pane-dropdown-left`, `pane-dropdown-right` — stage selector dropdowns
- `view-mode-{mode}` — view mode radio buttons
- `sidebar-section-{name}` — sidebar config sections
- `codec-step-{variable}-{index}` — individual codec pipeline steps
- `codec-warning-{variable}-{index}` — codec applicability warning icons

## Code Conventions

### File organization

Follow the project structure in the design doc. Keep engine logic in `src/engine/`, types in `src/types/`, React components in `src/components/`, state management in `src/state/`, hooks in `src/hooks/`.

### State management

Use React's built-in `useState`, `useMemo`, `useContext`. If prop drilling becomes painful, introduce Zustand — but try without it first.

### Styling

Use inline styles with values from `src/theme.ts`. The design doc specifies all colors, fonts, and spacing. Do not use CSS-in-JS libraries or Tailwind. A single `src/index.css` file can define CSS custom properties from the theme for use in rare cases where inline styles aren't sufficient (e.g., scrollbar styling, focus outlines).

### Performance

- Memoize all pipeline stage computations. A change to codec params should not recompute chunking or interleaving.
- Virtual scrolling for all list-type views. Use `@tanstack/react-virtual`.
- Debounce localStorage saves at 500ms.
- Keep the total element count reasonable (warn above 10K).

### Error handling

Do not crash on invalid user input. Degenerate states (zero variables, empty codecs, etc.) should produce empty but valid pipeline outputs. See the Edge Cases table in the design doc.

## Common Pitfalls

Based on earlier prototyping, these are the things most likely to go wrong:

1. **Byte tracing through size-changing codecs.** RLE and LZ change the byte count, breaking 1:1 trace mapping. After these codecs, traces must degrade to chunk-level. Do not try to maintain per-value tracing through entropy codecs.

2. **Virtual scrolling + hover state interaction.** Virtual scrolling unmounts rows that scroll out of view. Hover state must not depend on mounted elements — use data indices, not DOM refs. The `@tanstack/react-virtual` library handles this correctly if you key rows by data index.

3. **Codec dtype flow.** Each codec step has an input dtype and output dtype. Scale/offset changes the dtype (e.g., float32 → int16). The next codec in the pipeline receives the output dtype as its input. If this chain is broken, codecs will misinterpret bytes. Test the dtype flow explicitly.

4. **Interleaving mode switches.** When switching from column to row interleaving, per-field codec pipelines become inactive (but should be preserved in state). When switching back, they reactivate. The codec section UI must reflect this correctly.

5. **Resizable panels breaking layout.** The app is `height: 100vh` with no page scroll. Resizable panels must respect min/max constraints and not cause overflow. Test at various viewport sizes.

6. **Hex view alignment.** Each row must show exactly 16 bytes (or fewer for the last row). The offset column, hex bytes, gap at byte 8, and ASCII column must align across all rows regardless of content. Use monospace font and fixed-width spans.
