import { Panel, Group, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useAppState } from '../../state/useAppState.ts';
import { usePipeline } from '../../hooks/usePipeline.ts';
import { colors } from '../../theme.ts';
import { Header } from './Header.tsx';
import { Sidebar } from './Sidebar.tsx';
import { PipelineStrip } from './PipelineStrip.tsx';
import { StagePane } from '../viewers/StagePane.tsx';
import { HoverBar } from '../shared/HoverBar.tsx';

function MainLayout() {
  const { state, dispatch } = useAppState();
  const stages = usePipeline(state);

  const mainPersist = useDefaultLayout({ id: 'main-layout' });
  const panesPersist = useDefaultLayout({ id: 'panes-layout' });

  return (
    <Group
      orientation="horizontal"
      defaultLayout={mainPersist.defaultLayout}
      onLayoutChanged={mainPersist.onLayoutChanged}
    >
      <Panel id="sidebar" defaultSize="25%" minSize="15%" maxSize="35%">
        <Sidebar />
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
          <PipelineStrip stages={stages} />
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
