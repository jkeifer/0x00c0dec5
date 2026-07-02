import { Panel, Group, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useAppState } from '../../state/useAppState.ts';
import { usePipeline } from '../../hooks/usePipeline.ts';
import { PipelineProvider, usePipelineContext } from '../../state/PipelineContext.tsx';
import { colors } from '../../theme.ts';
import { Header } from './Header.tsx';
import { Sidebar } from './Sidebar.tsx';
import { PipelineStrip } from './PipelineStrip.tsx';
import { StagePane } from '../viewers/StagePane.tsx';
import { HoverBar } from '../shared/HoverBar.tsx';
import { ErrorBoundary } from '../shared/ErrorBoundary.tsx';

function MainLayout() {
  const { state, dispatch } = useAppState();
  const pipeline = usePipeline(state);

  const mainPersist = useDefaultLayout({ id: 'main-layout' });
  const panesPersist = useDefaultLayout({ id: 'panes-layout' });

  return (
    <PipelineProvider pipeline={pipeline} showDiff={state.ui.showDiff}>
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
            <PipelineStripConnected />
            <HoverBarConnected />
            <Group
              orientation="horizontal"
              defaultLayout={panesPersist.defaultLayout}
              onLayoutChanged={panesPersist.onLayoutChanged}
              style={{ flex: 1 }}
            >
              <Panel id="left-pane" defaultSize="50%" minSize="5%">
                <StagePane
                  paneId="left"
                  selectedStage={state.ui.leftPaneStage}
                  viewMode={state.ui.leftPaneView}
                  onStageChange={(stage) =>
                    dispatch({ type: 'UPDATE_UI', changes: { leftPaneStage: stage } })
                  }
                  onViewChange={(view) =>
                    dispatch({ type: 'UPDATE_UI', changes: { leftPaneView: view } })
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
                  selectedStage={state.ui.rightPaneStage}
                  viewMode={state.ui.rightPaneView}
                  onStageChange={(stage) =>
                    dispatch({ type: 'UPDATE_UI', changes: { rightPaneStage: stage } })
                  }
                  onViewChange={(view) =>
                    dispatch({ type: 'UPDATE_UI', changes: { rightPaneView: view } })
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
    </PipelineProvider>
  );
}

/** Thin context-consuming wrappers (task 3.9) so `PipelineStrip`/`HoverBar`
 * keep taking plain props (easy to test in isolation) while `MainLayout`
 * no longer drills pipeline fields into them by hand. */
function PipelineStripConnected() {
  const { stages, readResult, variableStats } = usePipelineContext();
  return <PipelineStrip stages={stages} readResult={readResult} variableStats={variableStats} />;
}

function HoverBarConnected() {
  const { stages } = usePipelineContext();
  return <HoverBar stages={stages} />;
}

export function App() {
  return (
    <>
      <Header />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ErrorBoundary>
          <MainLayout />
        </ErrorBoundary>
      </div>
    </>
  );
}
