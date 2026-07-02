import { useState, useMemo, useEffect, useRef } from 'react';
import type { Variable } from '../../types/state.ts';
import { flatIndexToCoords } from '../../engine/chunk.ts';
import { makeTraceId, parseTraceId } from '../../engine/trace.ts';
import { useHover } from '../../hooks/useHover.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

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
  values: Map<string, number[]>;
  chunkTraceMap?: Map<string, Set<string>>;
  traceChunkMap?: Map<string, string>;
  diffValues?: Map<string, number[]>;
  showDiff?: boolean;
}

const CELL_SIZE = 20;
const MAX_CELLS = 10000;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function diffToColor(diff: number, maxAbsDiff: number): string {
  if (maxAbsDiff === 0) return 'rgb(40,40,40)';
  const t = Math.max(-1, Math.min(1, diff / maxAbsDiff));
  // Diverging: negative = blue, zero = neutral gray, positive = red
  if (t >= 0) {
    const r = Math.round(lerp(40, 224, t));
    const g = Math.round(lerp(40, 108, t));
    const b = Math.round(lerp(40, 117, t));
    return `rgb(${r},${g},${b})`;
  } else {
    const at = -t;
    const r = Math.round(lerp(40, 97, at));
    const g = Math.round(lerp(40, 175, at));
    const b = Math.round(lerp(40, 239, at));
    return `rgb(${r},${g},${b})`;
  }
}

function valueToColor(value: number, min: number, max: number, baseColor: string): string {
  if (min === max) return baseColor;
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  // Blend from dark to the variable color based on intensity
  const r = parseInt(baseColor.slice(1, 3), 16);
  const g = parseInt(baseColor.slice(3, 5), 16);
  const b = parseInt(baseColor.slice(5, 7), 16);
  const outR = Math.round(lerp(20, r, t));
  const outG = Math.round(lerp(20, g, t));
  const outB = Math.round(lerp(20, b, t));
  return `rgb(${outR},${outG},${outB})`;
}

export function GridView({ variables, shape, paneId, values: valuesByName, chunkTraceMap, traceChunkMap, diffValues, showDiff }: GridViewProps) {
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
  // no byte decoding here (D6, fixes UI-9).
  const { values, min, max } = useMemo(() => {
    if (!selectedVar) return { values: [] as number[], min: Infinity, max: -Infinity };
    const vals = valuesByName.get(selectedVar.name) ?? [];

    let mn = Infinity;
    let mx = -Infinity;
    for (const v of vals) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }

    return { values: vals, min: mn, max: mx };
  }, [valuesByName, selectedVar]);

  // Determine grid dimensions from shape
  const rows = shape.length >= 2 ? shape[0] : 1;
  const cols = shape.length >= 2 ? shape[1] : shape[0] ?? 0;
  const is1D = shape.length < 2;
  const cellCount = Math.min(values.length, MAX_CELLS);

  // Cross-pane auto-scroll. Must check parseTraceId's `kind` before treating
  // the remainder as coordinates — a chunk-level id like 'chunk:0,1'
  // otherwise "parses" as variable name 'chunk' with bogus coords (UI-3).
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
    const cell = gridRef.current.querySelector(`[data-cell-idx="${idx}"]`);
    if (cell) {
      cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
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
              color: idx === effectiveVarIdx ? v.color : colors.textSecondary,
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

      {/* Grid */}
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
            const gridChunkTraceIds = hoveredChunkId ? chunkTraceMap?.get(hoveredChunkId) : undefined;
            const isChunkHovered = !isValueHovered && gridChunkTraceIds != null && gridChunkTraceIds.has(traceId);
            const chunkId = traceChunkMap?.get(traceId) ?? null;

            // Diff mode
            const origVal = origVarVals && i < origVarVals.length ? origVarVals[i] : undefined;
            const diffActive = showDiff && origVal !== undefined;
            const diff = diffActive ? val - origVal : 0;
            const maxAbsDiff = diffActive
              ? origVarVals!.reduce((mx, ov, j) => Math.max(mx, Math.abs(values[j] - ov)), 0)
              : 0;
            const cellColor = diffActive
              ? diffToColor(diff, maxAbsDiff)
              : valueToColor(val, min, max, selectedVar.color);
            const cellTitle = diffActive
              ? `Original: ${origVal}, Reconstructed: ${val}, Δ = ${(diff >= 0 ? '+' : '') + diff.toPrecision(4)}`
              : `${selectedVar.name}[${is1D ? i : `${row},${col}`}] = ${val}`;

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
                  outline: isValueHovered ? `2px solid ${colors.textPrimary}` : isChunkHovered ? `1px solid rgba(255,255,255,0.6)` : undefined,
                  outlineOffset: -1,
                  cursor: 'default',
                  transition: 'background-color 0.1s ease',
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
