import { useState, useMemo, useEffect, useRef } from 'react';
import type { Variable } from '../../types/state.ts';
import type { LogicalValue } from '../../types/dtypes.ts';
import { flatIndexToCoords } from '../../engine/chunk.ts';
import { makeTraceId, parseTraceId } from '../../engine/trace.ts';
import { formatLogicalValue } from '../../engine/elements.ts';
import { elementInChunk, chunkIdForElement, type ValueArray } from '../../engine/layout.ts';
import { useHover } from '../../hooks/useHover.ts';
import { colors, displayColor, fonts, fontSizes, spacing } from '../../theme.ts';
import { computeMaxAbsDiff, computeDiffSummary, scrollOffsetForCell } from './viewerUtils.ts';
import { valueToColor, diffToColor } from './gridImage.ts';
import { GridCanvas } from './GridCanvas.tsx';

interface GridViewProps {
  variables: Variable[];
  shape: number[];
  paneId: 'left' | 'right';
  /**
   * D6 (remediation-plan.md, Phase 3.3): source values per variable NAME,
   * supplied by the pipeline (`logicalValues`/`typedValues`/
   * `readResult.reconstructedValues`) rather than decoded from stage bytes
   * here. GridView only ever renders the Values/Typed/Read stages (see
   * StagePane's view-mode gating), so this is always populated for it.
   */
  values: Map<string, ValueArray>;
  chunkShape: number[];
  interleaving: 'row' | 'column';
  diffValues?: Map<string, ValueArray>;
  showDiff?: boolean;
}

const CELL_SIZE = 20;
const MAX_CELLS = 10000;

export function GridView({ variables, shape, paneId, values: valuesByName, chunkShape, interleaving, diffValues, showDiff }: GridViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const [selectedVarIdx, setSelectedVarIdx] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

  // Clamp to the valid range so the active tab and displayed data always agree,
  // even after a variable is removed and selectedVarIdx is now out of range.
  const effectiveVarIdx = Math.min(Math.max(selectedVarIdx, 0), variables.length - 1);
  const selectedVar = variables[effectiveVarIdx];

  // Compute diff data for the selected variable
  const origVarVals = showDiff && diffValues && selectedVar ? diffValues.get(selectedVar.name) : undefined;

  // Look up the selected variable's values from the pipeline-supplied map —
  // no byte decoding here (D6, fixes UI-9). `colorValues` is what feeds the
  // valueToColor lerp: identical to `values` for numeric variables, and an
  // ordinal (sorted-unique word index) mapping for text variables — this
  // branch fully replaces the numeric scan for string arrays, since
  // `'abc' < Infinity` is false and the numeric path would yield rgb(NaN).
  const { values, colorValues, min, max } = useMemo(() => {
    if (!selectedVar) {
      return { values: [] as LogicalValue[], colorValues: [] as number[], min: Infinity, max: -Infinity };
    }
    const vals = valuesByName.get(selectedVar.name) ?? [];

    // Text variables always arrive as a plain string[] (never Float64Array —
    // see ValueArray/generateValues), so this branch can safely narrow.
    if (vals.some((v) => typeof v === 'string')) {
      const words = vals as string[];
      const uniq = Array.from(new Set(words.map((v) => String(v)))).sort();
      const rank = new Map(uniq.map((w, i) => [w, i]));
      return {
        values: words,
        colorValues: words.map((v) => rank.get(String(v)) ?? 0),
        min: 0,
        max: uniq.length - 1,
      };
    }

    const nums = vals as Float64Array;
    let mn = Infinity;
    let mx = -Infinity;
    for (const v of nums) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }

    return { values: vals, colorValues: nums, min: mn, max: mx };
  }, [valuesByName, selectedVar]);

  // Task 4.5 (remediation-plan.md, fixes UI-5): maxAbsDiff was previously
  // recomputed with a full reduce PER CELL (an O(n^2) per-render cost) and
  // produced NaN whenever `values` and `origVarVals` had different lengths
  // (out-of-range reads returned `undefined`, and `val - undefined` is NaN,
  // which reaches `rgb(NaN,NaN,NaN)`). `computeMaxAbsDiff` is hoisted into
  // this memo (keyed on the two value arrays) and guards length mismatches
  // by only comparing indices present in both arrays.
  const maxAbsDiff = useMemo(() => {
    if (!showDiff || !origVarVals) return 0;
    return computeMaxAbsDiff(values, origVarVals);
  }, [showDiff, values, origVarVals]);

  // Per-variable diff summary (differing count / max / mean abs error) per
  // the extension doc's Diff View spec ("A summary shows max/mean absolute
  // error for the selected variable"). Memoized alongside maxAbsDiff so
  // hover-driven re-renders don't recompute it.
  const diffSummary = useMemo(() => {
    if (!showDiff || !origVarVals) return null;
    return computeDiffSummary(values, origVarVals);
  }, [showDiff, values, origVarVals]);

  // Determine grid dimensions from shape
  const rows = shape.length >= 2 ? shape[0] : 1;
  const cols = shape.length >= 2 ? shape[1] : shape[0] ?? 0;
  const is1D = shape.length < 2;
  const useCanvas = values.length > MAX_CELLS;
  // DOM path only needs the truncated count; canvas renders every element
  // (buildGridImage itself bounds by colorValues.length).
  const cellCount = Math.min(values.length, MAX_CELLS);

  // Task 5 (viewers plan): per-element diff arrays for GridCanvas, built once
  // per values/origVarVals change rather than per-pixel inside the canvas
  // component. Number-only, mirroring the DOM path's diffActive/diff
  // computation at GridView.tsx's cell-render loop below.
  const canvasDiffs = useMemo(() => {
    if (!useCanvas || !showDiff || !origVarVals) return undefined;
    const n = values.length;
    const diffs = new Float64Array(n);
    const diffActive = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const val = values[i];
      const orig = i < origVarVals.length ? origVarVals[i] : undefined;
      if (typeof val === 'number' && typeof orig === 'number') {
        diffs[i] = val - orig;
        diffActive[i] = 1;
      }
    }
    return { diffs, diffActive, maxAbsDiff };
  }, [useCanvas, showDiff, origVarVals, values, maxAbsDiff]);

  // Cross-pane auto-scroll. Must check parseTraceId's `kind` before treating
  // the remainder as coordinates — a chunk-level id like 'chunk:0,1'
  // otherwise "parses" as variable name 'chunk' with bogus coords (UI-3).
  //
  // Task 4.5 (remediation-plan.md, fixes UI-19): previously used
  // `gridRef.current.querySelector('[data-cell-idx=...]')` — the DOM-ref
  // pattern CLAUDE.md pitfall 2 forbids (hover/scroll state should be derived
  // from data indices, not by reaching into the DOM). GridView renders every
  // cell (it isn't virtualized) in a fixed-size CSS grid, so the scroll
  // offset for a given cell index is computable directly from `cols` and
  // `CELL_SIZE` — no element lookup needed. `scrollOffsetForCell` reproduces
  // `scrollIntoView({ block: 'nearest', inline: 'nearest' })` semantics.
  useEffect(() => {
    if (!hoveredTraceId || hoverSource === paneId || !gridRef.current || !selectedVar) return;
    const parsed = parseTraceId(hoveredTraceId);
    if (parsed.kind !== 'value' || parsed.coords.length === 0) return;
    if (parsed.variableName !== selectedVar.name) return;
    const parts = parsed.coords;
    if (parts.some((n) => Number.isNaN(n))) return;
    let idx = 0;
    for (let d = 0; d < parts.length; d++) {
      idx = idx * (shape[d] ?? 1) + parts[d];
    }
    const viewport = gridRef.current;
    const cols = shape.length >= 2 ? shape[1] : shape[0] ?? 1;
    const { scrollTop, scrollLeft } = scrollOffsetForCell(idx, cols, CELL_SIZE + 1, {
      scrollTop: viewport.scrollTop,
      scrollLeft: viewport.scrollLeft,
      clientWidth: viewport.clientWidth,
      clientHeight: viewport.clientHeight,
    });
    if (scrollTop !== viewport.scrollTop) viewport.scrollTop = scrollTop;
    if (scrollLeft !== viewport.scrollLeft) viewport.scrollLeft = scrollLeft;
  }, [hoveredTraceId, hoverSource, paneId, selectedVar, shape]);

  if (!selectedVar) {
    return (
      <div style={{ padding: spacing.md, color: colors.textTertiary }}>
        No variables defined
      </div>
    );
  }

  return (
    <div
      onMouseLeave={clearHover}
      data-testid="grid-view"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Variable selector tabs */}
      <div
        style={{
          display: 'flex',
          gap: spacing.xs,
          padding: `${spacing.xs}px ${spacing.sm}px`,
          borderBottom: `1px solid ${colors.borderSubtle}`,
          flexShrink: 0,
        }}
      >
        {variables.map((v, idx) => (
          <button
            key={v.id}
            onClick={() => setSelectedVarIdx(idx)}
            style={{
              background: idx === effectiveVarIdx ? v.color + '33' : 'transparent',
              color: idx === effectiveVarIdx ? displayColor(v.color) : colors.textSecondary,
              border: `1px solid ${idx === effectiveVarIdx ? v.color + '66' : colors.borderSubtle}`,
              borderRadius: 3,
              padding: `2px ${spacing.sm}px`,
              fontSize: fontSizes.sm,
              fontFamily: fonts.mono,
              cursor: 'pointer',
            }}
          >
            {v.name}
          </button>
        ))}
      </div>

      {is1D && (
        <div
          style={{
            padding: `${spacing.xs}px ${spacing.sm}px`,
            fontSize: fontSizes.xs,
            color: colors.textTertiary,
            flexShrink: 0,
          }}
        >
          Grid view is most useful with 2D+ data
        </div>
      )}

      {/* Task 4.5 / extension-read-step.md Diff View spec: per-variable diff
          summary (differing count / max / mean abs error) for the selected
          variable, kept visually lightweight — small text, warning color
          only when there are actual differences to flag. */}
      {diffSummary && (
        <div
          data-testid={`grid-diff-summary-${selectedVar.name}`}
          style={{
            padding: `${spacing.xs}px ${spacing.sm}px`,
            fontSize: fontSizes.xs,
            color: diffSummary.count > 0 ? colors.warning : colors.textTertiary,
            borderBottom: `1px solid ${colors.borderSubtle}`,
            flexShrink: 0,
            fontFamily: fonts.mono,
          }}
        >
          {diffSummary.count === 0
            ? 'No differences from original'
            : diffSummary.maxAbsError > 0
              ? `${diffSummary.count} differing / max Δ ${diffSummary.maxAbsError.toPrecision(4)} / mean Δ ${diffSummary.meanAbsError.toPrecision(4)}`
              // String (text) diffs have no numeric magnitude — Δ stats would misleadingly read 0.
              : `${diffSummary.count} differing`}
        </div>
      )}

      {/* Task 5 (viewers plan): above MAX_CELLS the DOM grid previously
          silently TRUNCATED to the first MAX_CELLS cells. GridCanvas replaces
          that truncation with full one-pixel-per-element rendering — no cap,
          no data loss. Below the threshold this is entirely unchanged. */}
      {useCanvas ? (
        <GridCanvas
          rows={rows}
          cols={cols}
          values={values}
          colorValues={colorValues}
          min={min}
          max={max}
          variable={selectedVar}
          chunkShape={chunkShape}
          interleaving={interleaving}
          paneId={paneId}
          shape={shape}
          diffs={canvasDiffs}
        />
      ) : (
      /* Grid */
      <div
        ref={gridRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: spacing.sm,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, ${CELL_SIZE}px)`,
            gap: 1,
          }}
        >
          {Array.from({ length: cellCount }, (_, i) => {
            const row = Math.floor(i / cols);
            const col = i % cols;
            if (row >= rows && !is1D) return null;

            const val = values[i];
            const coords = flatIndexToCoords(i, shape);
            const traceId = makeTraceId(selectedVar.name, coords);
            const isValueHovered = hoveredTraceId !== null && hoveredTraceId === traceId;
            const isChunkHovered = !isValueHovered && hoveredChunkId != null && hoveredChunkId !== ''
              && elementInChunk(hoveredChunkId, selectedVar.name, coords, chunkShape);
            const chunkId = chunkIdForElement(selectedVar.name, coords, chunkShape, interleaving);

            // Diff mode. `maxAbsDiff` is hoisted above into a useMemo keyed on
            // values/origVarVals (fixes UI-5's per-cell O(n) reduce); the
            // tooltip is formatted via the shared value-formatting helper
            // (formatLogicalValue) instead of showing raw unformatted numbers.
            const origVal = origVarVals && i < origVarVals.length ? origVarVals[i] : undefined;
            // Diff coloring/Δ math is number-only; text variables fall back
            // to the ordinal valueToColor ramp even with showDiff on (the
            // diff summary line above still counts string mismatches).
            const diffActive = showDiff && typeof val === 'number' && typeof origVal === 'number';
            const diff = diffActive ? val - origVal : 0;
            const cellColor = diffActive
              ? diffToColor(diff, maxAbsDiff)
              : valueToColor(colorValues[i], min, max, selectedVar.color);
            const cellTitle = diffActive
              ? `Original: ${formatLogicalValue(origVal!)}, Reconstructed: ${formatLogicalValue(val)}, Δ = ${(diff >= 0 ? '+' : '') + diff.toPrecision(4)}`
              : `${selectedVar.name}[${is1D ? i : `${row},${col}`}] = ${formatLogicalValue(val)}`;

            return (
              <div
                key={i}
                data-cell-idx={i}
                onMouseEnter={() => setHover(traceId, chunkId, paneId)}
                title={cellTitle}
                style={{
                  width: CELL_SIZE,
                  height: CELL_SIZE,
                  backgroundColor: cellColor,
                  outline: isValueHovered ? `2px solid ${colors.textPrimary}` : isChunkHovered ? '1px solid var(--chunk-outline)' : undefined,
                  outlineOffset: -1,
                  cursor: 'default',
                  transition: 'background-color 0.1s ease',
                }}
              />
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}
