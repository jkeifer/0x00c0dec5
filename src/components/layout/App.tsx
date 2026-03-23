import { useMemo } from 'react';
import { Panel, Group, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useAppState } from '../../state/useAppState.ts';
import { usePipeline } from '../../hooks/usePipeline.ts';
import { colors } from '../../theme.ts';
import { Header } from './Header.tsx';
import { Sidebar } from './Sidebar.tsx';
import { PipelineStrip } from './PipelineStrip.tsx';
import { StagePane } from '../viewers/StagePane.tsx';
import { HoverBar } from '../shared/HoverBar.tsx';
import { bytesToValues } from '../../engine/elements.ts';

function MainLayout() {
  const { state, dispatch } = useAppState();
  const { stages, files, chunkTraceMap, traceChunkMap, readResult, variableStats } = usePipeline(state);

  const mainPersist = useDefaultLayout({ id: 'main-layout' });
  const panesPersist = useDefaultLayout({ id: 'panes-layout' });

  // Compute originalValues from the Values stage (stage 0) for diff overlay
  // Values stage now uses float64 (8 bytes per value per variable)
  const originalValues = useMemo(() => {
    const valuesStage = stages[0];
    if (!valuesStage || valuesStage.bytes.length === 0) return undefined;

    const result = new Map<string, number[]>();
    let offset = 0;
    const totalBytesPerElement = state.variables.length * 8; // float64
    const totalElements = totalBytesPerElement > 0
      ? Math.floor(valuesStage.bytes.length / totalBytesPerElement)
      : 0;

    for (const v of state.variables) {
      const byteLen = totalElements * 8; // float64
      const varBytes = valuesStage.bytes.slice(offset, offset + byteLen);
      const values = bytesToValues(varBytes, 'float64');
      result.set(v.name, values);
      offset += byteLen;
    }

    return result;
  }, [stages, state.variables]);

  return (
    <Group
      orientation="horizontal"
      defaultLayout={mainPersist.defaultLayout}
      onLayoutChanged={mainPersist.onLayoutChanged}
    >
      <Panel id="sidebar" defaultSize="25%" minSize="15%" maxSize="35%">
        <Sidebar files={files} readResult={readResult} variableStats={variableStats} />
      </Panel>
      <Separator className="resize-handle" />
      <Panel id="main" minSize="30%">
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
          }}
        >
          <PipelineStrip stages={stages} readResult={readResult} variableStats={variableStats} />
          <HoverBar stages={stages} />
          <Group
            orientation="horizontal"
            defaultLayout={panesPersist.defaultLayout}
            onLayoutChanged={panesPersist.onLayoutChanged}
            style={{ flex: 1 }}
          >
            <Panel id="left-pane" defaultSize="50%" minSize="5%">
              <StagePane
                paneId="left"
                stages={stages}
                selectedStage={state.ui.leftPaneStage}
                viewMode={state.ui.leftPaneView}
                onStageChange={(stage) =>
                  dispatch({ type: 'SET_LEFT_PANE_STAGE', stage })
                }
                onViewChange={(view) =>
                  dispatch({ type: 'SET_LEFT_PANE_VIEW', view })
                }
                accentColor={colors.paneAccentLeft}
                variables={state.variables}
                shape={state.shape}
                files={files}
                chunkTraceMap={chunkTraceMap}
                traceChunkMap={traceChunkMap}
                readResult={readResult}
                showDiff={state.ui.showDiff}
                originalValues={originalValues}
              />
            </Panel>
            <Separator className="resize-handle" />
            <Panel id="right-pane" defaultSize="50%" minSize="5%">
              <StagePane
                paneId="right"
                stages={stages}
                selectedStage={state.ui.rightPaneStage}
                viewMode={state.ui.rightPaneView}
                onStageChange={(stage) =>
                  dispatch({ type: 'SET_RIGHT_PANE_STAGE', stage })
                }
                onViewChange={(view) =>
                  dispatch({ type: 'SET_RIGHT_PANE_VIEW', view })
                }
                accentColor={colors.paneAccentRight}
                variables={state.variables}
                shape={state.shape}
                files={files}
                chunkTraceMap={chunkTraceMap}
                traceChunkMap={traceChunkMap}
                readResult={readResult}
                showDiff={state.ui.showDiff}
                originalValues={originalValues}
              />
            </Panel>
          </Group>
        </div>
      </Panel>
    </Group>
  );
}

export function App() {
  return (
    <>
      <Header />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <MainLayout />
      </div>
    </>
  );
}
