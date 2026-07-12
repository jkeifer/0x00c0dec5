import { Fragment, useEffect, useRef } from 'react';
import { useAppState } from '../../state/useAppState.ts';
import { usePipelineContext } from '../../state/PipelineContext.tsx';
import { useGuide } from '../../state/GuideContext.tsx';
import { SchemaEditor } from '../config/SchemaEditor.tsx';
import { ChunkConfig } from '../config/ChunkConfig.tsx';
import { InterleaveConfig } from '../config/InterleaveConfig.tsx';
import { TypeAssignConfig } from '../config/TypeAssignConfig.tsx';
import { CodecSection } from '../config/CodecSection.tsx';
import { MetadataEditor } from '../config/MetadataEditor.tsx';
import { WriteConfig } from '../config/WriteConfig.tsx';
import { ReadStatus } from '../config/ReadStatus.tsx';
import { FileExplorer } from '../files/FileExplorer.tsx';
import { colors, fontSizes, radii, spacing } from '../../theme.ts';

const SECTIONS = ['Schema', 'Chunk', 'Interleave', 'Type Assignment', 'Codecs', 'Metadata', 'Write', 'Read'] as const;

// CLAUDE.md's "Data-testid conventions" enumerates: schema, chunk, interleave, codecs,
// metadata, write, read. "Type Assignment" is a section that postdates that list (see
// docs/remediation-plan.md §1.9 spec/docs divergence); it is given its own non-colliding
// slug ("typing") rather than reusing "codecs", since reusing an id would break uniqueness.
const SECTION_TESTIDS: Record<(typeof SECTIONS)[number], string> = {
  Schema: 'schema',
  Chunk: 'chunk',
  Interleave: 'interleave',
  'Type Assignment': 'typing',
  Codecs: 'codecs',
  Metadata: 'metadata',
  Write: 'write',
  Read: 'read',
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: fontSizes.sm,
  color: colors.textPrimary,
  textTransform: 'uppercase',
  letterSpacing: '0.8px',
  fontWeight: 600,
  margin: `0 0 ${spacing.xs}px`,
};

// Rendered as a flex sibling BETWEEN sections (not inside them), so the
// column gap spaces it evenly on both sides and the guide highlight outline
// wraps only a section's label + content, symmetric between dividers.
const dividerStyle: React.CSSProperties = {
  height: 1,
  background: colors.borderSubtle,
  flexShrink: 0,
};

// Task 3.9 (remediation-plan.md, Phase 3): files/readResult/variableStats
// come from PipelineContext now — Sidebar took no other pipeline-derived
// props, so consuming context directly (rather than adding a prop-drilling
// wrapper) removes the last props App.tsx had to thread through it.
export function Sidebar() {
  const { state, dispatch } = useAppState();
  const { files, readResult, variableStats, runtimeStatus } = usePipelineContext();
  // Guide highlight (plan Phase 5): the section matching the guide's active
  // step gets an accent outline and is scrolled into view.
  const { activeSection } = useGuide();
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!activeSection) return;
    sectionRefs.current
      .get(activeSection)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeSection]);

  function renderSection(section: (typeof SECTIONS)[number]) {
    switch (section) {
      case 'Schema':
        return (
          <SchemaEditor
            variables={state.variables}
            shape={state.shape}
            dataModel={state.dataModel}
            onAddVariable={() => {
              const color =
                colors.palette[state.variables.length % colors.palette.length];
              dispatch({
                type: 'ADD_VARIABLE',
                variable: {
                  id: `var_${Date.now()}`,
                  name: '',
                  logicalType: { type: 'decimal', min: -50, max: 50, decimalPlaces: 1, generation: 'random' },
                  typeAssignment: { storageDtype: 'float32' },
                  color,
                },
              });
            }}
            onRemoveVariable={(id) => dispatch({ type: 'REMOVE_VARIABLE', id })}
            onUpdateVariable={(id, changes) =>
              dispatch({ type: 'UPDATE_VARIABLE', id, changes })
            }
            onShapeChange={(shape) => dispatch({ type: 'SET_SHAPE', shape })}
          />
        );
      case 'Chunk':
        return (
          <ChunkConfig
            shape={state.shape}
            chunkShape={state.chunkShape}
            onChunkShapeChange={(chunkShape) =>
              dispatch({ type: 'SET_CHUNK_SHAPE', chunkShape })
            }
          />
        );
      case 'Interleave':
        return (
          <InterleaveConfig
            interleaving={state.interleaving}
            dataModel={state.dataModel}
            onChange={(interleaving) =>
              dispatch({ type: 'SET_INTERLEAVING', interleaving })
            }
          />
        );
      case 'Type Assignment':
        return (
          <TypeAssignConfig
            variables={state.variables}
            variableStats={variableStats}
            onUpdateVariable={(id, changes) =>
              dispatch({ type: 'UPDATE_VARIABLE', id, changes })
            }
          />
        );
      case 'Codecs':
        return (
          <CodecSection
            interleaving={state.interleaving}
            variables={state.variables}
            fieldPipelines={state.fieldPipelines}
            chunkPipeline={state.chunkPipeline}
            runtimeStatus={runtimeStatus}
            onFieldPipelineChange={(variableId, steps) =>
              dispatch({ type: 'SET_FIELD_PIPELINE', variableId, steps })
            }
            onChunkPipelineChange={(steps) =>
              dispatch({ type: 'SET_CHUNK_PIPELINE', steps })
            }
          />
        );
      case 'Metadata':
        return (
          <MetadataEditor
            metadata={state.metadata}
            state={state}
            onSerializationChange={(serialization) =>
              dispatch({ type: 'UPDATE_METADATA_CONFIG', changes: { serialization } })
            }
            onAddEntry={() => dispatch({ type: 'ADD_METADATA_ENTRY' })}
            onRemoveEntry={(index) =>
              dispatch({ type: 'REMOVE_METADATA_ENTRY', index })
            }
            onUpdateEntry={(index, key, value) =>
              dispatch({ type: 'UPDATE_METADATA_ENTRY', index, key, value })
            }
            onIncludeChange={(key, value) =>
              dispatch({
                type: 'UPDATE_METADATA_CONFIG',
                changes: { include: { ...state.metadata.include, [key]: value } },
              })
            }
          />
        );
      case 'Write':
        return (
          <>
            <WriteConfig
              write={state.write}
              onMagicChange={(magicNumber) =>
                dispatch({ type: 'UPDATE_WRITE', changes: { magicNumber } })
              }
              onPartitioningChange={(partitioning) =>
                dispatch({ type: 'UPDATE_WRITE', changes: { partitioning } })
              }
              onMetadataPlacementChange={(metadataPlacement) =>
                dispatch({ type: 'UPDATE_WRITE', changes: { metadataPlacement } })
              }
              onChunkOrderChange={(chunkOrder) =>
                dispatch({ type: 'UPDATE_WRITE', changes: { chunkOrder } })
              }
              onIncludeMetadataChange={(includeMetadata) =>
                dispatch({ type: 'UPDATE_WRITE', changes: { includeMetadata } })
              }
              onFooterLocatorChange={(footerLocator) =>
                dispatch({ type: 'UPDATE_WRITE', changes: { footerLocator } })
              }
            />
            <FileExplorer files={files} />
          </>
        );
      case 'Read':
        return (
          <ReadStatus
            readResult={readResult}
            showDiff={state.ui.showDiff}
            onShowDiffChange={(showDiff) =>
              dispatch({ type: 'UPDATE_UI', changes: { showDiff } })
            }
          />
        );
      default:
        return null;
    }
  }

  return (
    <aside
      aria-label="Pipeline configuration"
      style={{
        background: colors.surface,
        overflowY: 'auto',
        padding: spacing.md,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        height: '100%',
      }}
    >
      {SECTIONS.map((section, i) => {
        const slug = SECTION_TESTIDS[section];
        const isGuideActive = slug === activeSection;
        return (
          <Fragment key={section}>
            {i > 0 && <div style={dividerStyle} />}
            <div
              data-testid={`sidebar-section-${slug}`}
              data-guide-active={isGuideActive || undefined}
              ref={(el) => {
                if (el) sectionRefs.current.set(slug, el);
                else sectionRefs.current.delete(slug);
              }}
              style={
                isGuideActive
                  ? {
                      outline: `2px solid ${colors.accent}`,
                      outlineOffset: 4,
                      borderRadius: radii.sm,
                    }
                  : undefined
              }
            >
              <h2 style={sectionLabelStyle}>{section}</h2>
              {renderSection(section)}
            </div>
          </Fragment>
        );
      })}
    </aside>
  );
}
