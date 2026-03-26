import { useRef, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { VirtualFile, ChunkRegion } from '../../types/pipeline.ts';
import { useHover } from '../../hooks/useHover.ts';
import { useContainerWidth } from '../../hooks/useContainerWidth.ts';
import { formatOffset, formatFileSize, buildTraceIndex, buildChunkIndex, buildChunkRegions } from './viewerUtils.ts';
import { HexRowRenderer } from './HexRowRenderer.tsx';
import { colors, fonts, fontSizes, spacing } from '../../theme.ts';

interface WriteHexViewProps {
  files: VirtualFile[];
  paneId: 'left' | 'right';
  chunkTraceMap: Map<string, Set<string>>;
  traceChunkMap: Map<string, string>;
}

const NARROW_BREAKPOINT = 500;
const ROW_HEIGHT = 20;
const HEADER_HEIGHT = 28;

interface FileData {
  file: VirtualFile;
  regionByByte: Uint8Array;
  regionBoundaries: Set<number>;
  chunkRegions: ChunkRegion[];
  traceIndex: Map<string, number>;
  chunkIndex: Map<string, number>;
  rowCount: number;
}

interface FileHexSectionHandle {
  scrollToRow: (rowIndex: number) => void;
}

interface FileHexSectionProps {
  fileData: FileData;
  fileIndex: number;
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  scrollMargin: number;
  bytesPerRow: number;
  offsetWidth: number;
  hoveredTraceId: string | null;
  hoveredChunkId: string | null;
  isCrossPane: boolean;
  chunkTraceMap: Map<string, Set<string>>;
  onHover: (traceId: string, chunkId: string) => void;
  showHeader: boolean;
}

const FileHexSection = forwardRef<FileHexSectionHandle, FileHexSectionProps>(
  function FileHexSection(
    {
      fileData,
      fileIndex,
      scrollElementRef,
      scrollMargin,
      bytesPerRow,
      offsetWidth,
      hoveredTraceId,
      hoveredChunkId,
      isCrossPane,
      chunkTraceMap,
      onHover,
      showHeader,
    },
    ref,
  ) {
    const virtualizer = useVirtualizer({
      count: fileData.rowCount,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 10,
      scrollMargin,
    });

    useImperativeHandle(ref, () => ({
      scrollToRow: (rowIndex: number) => {
        virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
      },
    }));

    return (
      <>
        {showHeader && (
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 1,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: `${spacing.xs}px ${spacing.sm}px`,
              background: colors.surfaceHover,
              borderTop: fileIndex > 0 ? `1px solid ${colors.border}` : undefined,
              borderBottom: `1px solid ${colors.borderSubtle}`,
              fontSize: fontSizes.sm,
              lineHeight: `${HEADER_HEIGHT - spacing.xs * 2}px`,
              height: HEADER_HEIGHT,
              boxSizing: 'border-box',
            }}
          >
            <span style={{ color: colors.textPrimary }}>{fileData.file.name}</span>
            <span style={{ color: colors.textTertiary, marginLeft: spacing.sm }}>
              {formatFileSize(fileData.file.bytes.length)}
            </span>
          </div>
        )}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const rowIndex = virtualRow.index;
            const byteStart = rowIndex * bytesPerRow;
            const byteEnd = Math.min(byteStart + bytesPerRow, fileData.file.bytes.length);

            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: virtualRow.start - virtualizer.options.scrollMargin,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                  display: 'flex',
                  whiteSpace: 'pre',
                  padding: `0 ${spacing.sm}px`,
                }}
              >
                <HexRowRenderer
                  rowIndex={rowIndex}
                  byteStart={byteStart}
                  byteEnd={byteEnd}
                  bytesPerRow={bytesPerRow}
                  bytes={fileData.file.bytes}
                  traces={fileData.file.traces}
                  regionByByte={fileData.regionByByte}
                  regionBoundaries={fileData.regionBoundaries}
                  offsetWidth={offsetWidth}
                  totalBytes={fileData.file.bytes.length}
                  hoveredTraceId={hoveredTraceId}
                  hoveredChunkId={hoveredChunkId}
                  isCrossPane={isCrossPane}
                  chunkTraceMap={chunkTraceMap}
                  onHover={onHover}
                />
              </div>
            );
          })}
        </div>
      </>
    );
  },
);

export function WriteHexView({ files, paneId, chunkTraceMap, traceChunkMap: _traceChunkMap }: WriteHexViewProps) {
  const { hoveredTraceId, hoveredChunkId, hoverSource, setHover, clearHover } = useHover();
  const parentRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(parentRef);
  const bytesPerRow = containerWidth > 0 && containerWidth < NARROW_BREAKPOINT ? 8 : 16;

  // Refs array for per-file virtualizer handles
  const sectionRefs = useRef<(FileHexSectionHandle | null)[]>([]);

  // Precompute per-file data
  const fileDataList = useMemo((): FileData[] => {
    return files.map((file) => {
      const chunkRegions = buildChunkRegions(file.traces);
      const regionByByte = new Uint8Array(file.bytes.length);
      for (let r = 0; r < chunkRegions.length; r++) {
        const region = chunkRegions[r];
        for (let i = region.startByte; i < region.endByte; i++) {
          regionByByte[i] = r % 2;
        }
      }
      const regionBoundaries = new Set<number>();
      for (const region of chunkRegions) {
        if (region.startByte > 0) regionBoundaries.add(region.startByte);
      }
      return {
        file,
        regionByByte,
        regionBoundaries,
        chunkRegions,
        traceIndex: buildTraceIndex(file.traces),
        chunkIndex: buildChunkIndex(file.traces),
        rowCount: Math.ceil(file.bytes.length / bytesPerRow),
      };
    });
  }, [files, bytesPerRow]);

  // Compute scrollMargin for each file section statically
  const scrollMargins = useMemo(() => {
    const margins: number[] = [];
    let offset = 0;
    const showHeaders = files.length > 1;
    for (let i = 0; i < fileDataList.length; i++) {
      margins.push(offset);
      if (showHeaders) offset += HEADER_HEIGHT;
      offset += fileDataList[i].rowCount * ROW_HEIGHT;
    }
    return margins;
  }, [fileDataList, files.length]);

  // Compute total bytes across all files for offset width
  const maxFileBytes = useMemo(() => {
    let max = 0;
    for (const file of files) {
      if (file.bytes.length > max) max = file.bytes.length;
    }
    return max;
  }, [files]);

  const offsetWidth = formatOffset(0, maxFileBytes).length;

  const isCrossPane = hoverSource !== null && hoverSource !== paneId;

  const handleHover = useCallback(
    (traceId: string, chunkId: string) => setHover(traceId, chunkId, paneId),
    [setHover, paneId],
  );

  // Cross-pane scroll sync: find trace across all files
  useEffect(() => {
    if (hoveredTraceId && hoverSource !== paneId) {
      for (let fi = 0; fi < fileDataList.length; fi++) {
        const fd = fileDataList[fi];
        let byteIdx = fd.traceIndex.get(hoveredTraceId);
        if (byteIdx === undefined && hoveredChunkId) {
          byteIdx = fd.chunkIndex.get(hoveredChunkId);
        }
        if (byteIdx !== undefined) {
          const rowIdx = Math.floor(byteIdx / bytesPerRow);
          sectionRefs.current[fi]?.scrollToRow(rowIdx);
          return;
        }
      }
    }
  }, [hoveredTraceId, hoveredChunkId, hoverSource, paneId, fileDataList, bytesPerRow]);

  const showHeaders = files.length > 1;

  return (
    <div
      ref={parentRef}
      onMouseLeave={clearHover}
      style={{
        height: '100%',
        overflow: 'auto',
        fontFamily: fonts.mono,
        fontSize: fontSizes.md,
        lineHeight: `${ROW_HEIGHT}px`,
      }}
    >
      {fileDataList.map((fd, fi) => (
        <FileHexSection
          key={fi}
          ref={(handle) => { sectionRefs.current[fi] = handle; }}
          fileData={fd}
          fileIndex={fi}
          scrollElementRef={parentRef}
          scrollMargin={scrollMargins[fi]}
          bytesPerRow={bytesPerRow}
          offsetWidth={offsetWidth}
          hoveredTraceId={hoveredTraceId}
          hoveredChunkId={hoveredChunkId}
          isCrossPane={isCrossPane}
          chunkTraceMap={chunkTraceMap}
          onHover={handleHover}
          showHeader={showHeaders}
        />
      ))}
    </div>
  );
}
