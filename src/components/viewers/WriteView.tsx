import { useRef, useMemo } from 'react';
import type { VirtualFile, PipelineStage } from '../../types/pipeline.ts';
import { buildChunkRegions } from './viewerUtils.ts';
import { shannonEntropy } from '../../engine/codecs.ts';
import { useContainerWidth } from '../../hooks/useContainerWidth.ts';
import { HexView } from './HexView.tsx';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

interface WriteViewProps {
  files: VirtualFile[];
  paneId: 'left' | 'right';
  chunkTraceMap: Map<string, Set<string>>;
  traceChunkMap: Map<string, string>;
}

const NARROW_BREAKPOINT = 500;
const ROW_HEIGHT = 20;
const MAX_HEX_HEIGHT = 600;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToStage(file: VirtualFile): PipelineStage {
  return {
    name: file.name,
    bytes: file.bytes,
    traces: file.traces,
    chunkRegions: buildChunkRegions(file.traces),
    stats: {
      byteCount: file.bytes.length,
      entropy: shannonEntropy(file.bytes),
    },
  };
}

export function WriteView({ files, paneId, chunkTraceMap, traceChunkMap }: WriteViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(containerRef);
  const bytesPerRow = containerWidth > 0 && containerWidth < NARROW_BREAKPOINT ? 8 : 16;

  // Memoize file-to-stage conversions
  const fileStages = useMemo(
    () => files.map((file) => fileToStage(file)),
    [files],
  );

  return (
    <div
      ref={containerRef}
      style={{
        height: '100%',
        overflow: 'auto',
      }}
    >
      {files.map((file, i) => {
        const rowCount = Math.ceil(file.bytes.length / bytesPerRow);
        const hexHeight = Math.min(rowCount * ROW_HEIGHT, MAX_HEX_HEIGHT);
        const stage = fileStages[i];

        return (
          <div key={i}>
            {/* File header */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: `${spacing.xs}px ${spacing.sm}px`,
                background: colors.surfaceHover,
                borderTop: i > 0 ? `1px solid ${colors.border}` : undefined,
                borderBottom: `1px solid ${colors.borderSubtle}`,
                fontFamily: fonts.mono,
                fontSize: fontSizes.sm,
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              <span style={{ color: colors.textPrimary }}>{file.name}</span>
              <span style={{ color: colors.textTertiary, marginLeft: spacing.sm }}>
                {formatFileSize(file.bytes.length)}
              </span>
            </div>

            {/* Hex dump with capped height */}
            <div style={{ height: hexHeight }}>
              <HexView stage={stage} paneId={paneId} chunkTraceMap={chunkTraceMap} traceChunkMap={traceChunkMap} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
