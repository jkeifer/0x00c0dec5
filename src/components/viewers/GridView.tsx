import { useState, useMemo, useEffect, useRef } from 'react';
import type { PipelineStage } from '../../types/pipeline.ts';
import type { Variable } from '../../types/state.ts';
import { getDtype } from '../../types/dtypes.ts';
import { bytesToValues } from '../../engine/elements.ts';
import { flatIndexToCoords } from '../../engine/chunk.ts';
import { useHover } from '../../hooks/useHover.ts';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

interface GridViewProps {
  stage: PipelineStage;
  variables: Variable[];
  shape: number[];
  paneId: 'left' | 'right';
  chunkTraceMap?: Map<string, Set<string>>;
  traceChunkMap?: Map<string, string>;
}

const CELL_SIZE = 20;
const MAX_CELLS = 10000;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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

export function GridView({ stage, variables, shape, paneId, chunkTraceMap, traceChunkMap }: GridViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const [selectedVarIdx, setSelectedVarIdx] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

  const selectedVar = variables[selectedVarIdx] ?? variables[0];
  if (!selectedVar) {
    return (
      <div style={{ padding: spacing.md, color: colors.textTertiary }}>
        No variables defined
      </div>
    );
  }

  // Reconstruct values for selected variable
  const { values, min, max } = useMemo(() => {
    let offset = 0;
    for (let i = 0; i < selectedVarIdx && i < variables.length; i++) {
      const info = getDtype(variables[i].dtype);
      const totalElements = computeTotalElements(stage, variables);
      offset += totalElements * info.size;
    }
    const info = getDtype(selectedVar.dtype);
    const totalElements = computeTotalElements(stage, variables);
    const byteLen = totalElements * info.size;
    const varBytes = stage.bytes.slice(offset, offset + byteLen);
    const vals = bytesToValues(varBytes, selectedVar.dtype);

    let mn = Infinity;
    let mx = -Infinity;
    for (const v of vals) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }

    return { values: vals, min: mn, max: mx };
  }, [stage, variables, selectedVarIdx, selectedVar]);

  // Determine grid dimensions from shape
  const rows = shape.length >= 2 ? shape[0] : 1;
  const cols = shape.length >= 2 ? shape[1] : shape[0] ?? 0;
  const is1D = shape.length < 2;
  const cellCount = Math.min(values.length, MAX_CELLS);

  // Cross-pane auto-scroll
  useEffect(() => {
    if (!hoveredTraceId || hoverSource === paneId || !gridRef.current) return;
    const colonIdx = hoveredTraceId.indexOf(':');
    if (colonIdx < 0) return;
    const varName = hoveredTraceId.slice(0, colonIdx);
    if (varName !== selectedVar.name) return;
    const coordStr = hoveredTraceId.slice(colonIdx + 1);
    const parts = coordStr.split(',').map(Number);
    if (parts.some(isNaN)) return;
    let idx = 0;
    for (let d = 0; d < parts.length; d++) {
      idx = idx * (shape[d] ?? 1) + parts[d];
    }
    const cell = gridRef.current.querySelector(`[data-cell-idx="${idx}"]`);
    if (cell) {
      cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [hoveredTraceId, hoverSource, paneId, selectedVar.name, shape]);

  return (
    <div
      onMouseLeave={clearHover}
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
              background: idx === selectedVarIdx ? v.color + '33' : 'transparent',
              color: idx === selectedVarIdx ? v.color : colors.textSecondary,
              border: `1px solid ${idx === selectedVarIdx ? v.color + '66' : colors.borderSubtle}`,
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
            const traceId = `${selectedVar.name}:${coords.join(',')}`;
            const isValueHovered = hoveredTraceId !== null && hoveredTraceId === traceId;
            const gridChunkTraceIds = hoveredChunkId ? chunkTraceMap?.get(hoveredChunkId) : undefined;
            const isChunkHovered = !isValueHovered && gridChunkTraceIds != null && gridChunkTraceIds.has(traceId);
            const cellColor = valueToColor(val, min, max, selectedVar.color);
            const chunkId = traceChunkMap?.get(traceId) ?? null;

            return (
              <div
                key={i}
                data-cell-idx={i}
                onMouseEnter={() => setHover(traceId, chunkId, paneId)}
                title={`${selectedVar.name}[${is1D ? i : `${row},${col}`}] = ${val}`}
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

function computeTotalElements(stage: PipelineStage, variables: Variable[]): number {
  let totalBytesPerElement = 0;
  for (const v of variables) {
    totalBytesPerElement += getDtype(v.dtype).size;
  }
  if (totalBytesPerElement === 0) return 0;
  return Math.floor(stage.bytes.length / totalBytesPerElement);
}
