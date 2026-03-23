import { useAppState } from '../../state/useAppState.ts';
import { SchemaEditor } from '../config/SchemaEditor.tsx';
import { ChunkConfig } from '../config/ChunkConfig.tsx';
import { InterleaveConfig } from '../config/InterleaveConfig.tsx';
import { CodecSection } from '../config/CodecSection.tsx';
import { MetadataEditor } from '../config/MetadataEditor.tsx';
import { WriteConfig } from '../config/WriteConfig.tsx';
import { FileExplorer } from '../files/FileExplorer.tsx';
import { colors, fontSizes, spacing } from '../../theme.ts';
import type { VirtualFile } from '../../types/pipeline.ts';

const SECTIONS = ['Schema', 'Chunk', 'Interleave', 'Codecs', 'Metadata', 'Write'] as const;

const sectionLabelStyle: React.CSSProperties = {
  fontSize: fontSizes.sm,
  color: colors.textSecondary,
  textTransform: 'uppercase',
  letterSpacing: '0.8px',
  fontWeight: 600,
  marginBottom: spacing.xs,
};

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: colors.borderSubtle,
  marginBottom: 14,
};

interface SidebarProps {
  files: VirtualFile[];
}

export function Sidebar({ files }: SidebarProps) {
  const { state, dispatch } = useAppState();

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
                  dtype: 'float32',
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
      case 'Codecs':
        return (
          <CodecSection
            interleaving={state.interleaving}
            variables={state.variables}
            fieldPipelines={state.fieldPipelines}
            chunkPipeline={state.chunkPipeline}
            onFieldPipelineChange={(variableName, steps) =>
              dispatch({ type: 'SET_FIELD_PIPELINE', variableName, steps })
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
              dispatch({ type: 'SET_METADATA_SERIALIZATION', serialization })
            }
            onAddEntry={() => dispatch({ type: 'ADD_METADATA_ENTRY' })}
            onRemoveEntry={(index) =>
              dispatch({ type: 'REMOVE_METADATA_ENTRY', index })
            }
            onUpdateEntry={(index, key, value) =>
              dispatch({ type: 'UPDATE_METADATA_ENTRY', index, key, value })
            }
          />
        );
      case 'Write':
        return (
          <>
            <WriteConfig
              write={state.write}
              onMagicChange={(magicNumber) =>
                dispatch({ type: 'SET_WRITE_MAGIC', magicNumber })
              }
              onPartitioningChange={(partitioning) =>
                dispatch({ type: 'SET_WRITE_PARTITIONING', partitioning })
              }
              onMetadataPlacementChange={(metadataPlacement) =>
                dispatch({ type: 'SET_WRITE_METADATA_PLACEMENT', metadataPlacement })
              }
              onChunkOrderChange={(chunkOrder) =>
                dispatch({ type: 'SET_WRITE_CHUNK_ORDER', chunkOrder })
              }
            />
            <FileExplorer files={files} />
          </>
        );
      default: {
        const _exhaustive: never = section;
        return null;
      }
    }
  }

  return (
    <div
      style={{
        background: colors.surface,
        overflowY: 'auto',
        padding: spacing.md,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        height: '100%',
      }}
    >
      {SECTIONS.map((section, i) => (
        <div key={section}>
          {i > 0 && <div style={dividerStyle} />}
          <div style={sectionLabelStyle}>{section}</div>
          {renderSection(section)}
        </div>
      ))}
    </div>
  );
}
