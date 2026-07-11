import { Panel, Group, Separator, useDefaultLayout } from 'react-resizable-panels';
import type { Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';
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
import { GuideProvider } from '../../state/GuideContext.tsx';
import { GuidePanel } from '../guide/GuidePanel.tsx';

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
        {/* minSize is a pixel string, not a percentage (UI-17): 15% of a
            900px window is only 135px, well below the ~200px the sidebar's
            config rows need before they wrap badly. react-resizable-panels
            v4's Panel accepts a "px"-suffixed string directly (see
            node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts,
            PanelProps.minSize: number | string, "Pixels may also be
            specified as strings ending with the unit 'px'"). */}
        <Panel id="sidebar" defaultSize="25%" minSize="200px" maxSize="35%">
          <Sidebar />
        </Panel>
        <Separator className="resize-handle" />
        <Panel id="main" minSize="30%">
          <main
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              overflow: 'hidden',
            }}
          >
            <PipelineStripConnected
              variables={state.variables}
              fieldPipelines={state.fieldPipelines}
              chunkPipeline={state.chunkPipeline}
              interleaving={state.interleaving}
            />
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
                  chunkShape={state.chunkShape}
                  interleaving={state.interleaving}
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
                  chunkShape={state.chunkShape}
                  interleaving={state.interleaving}
                />
              </Panel>
            </Group>
          </main>
        </Panel>
      </Group>
    </PipelineProvider>
  );
}

/** Thin context-consuming wrappers (task 3.9) so `PipelineStrip`/`HoverBar`
 * keep taking plain props (easy to test in isolation) while `MainLayout`
 * no longer drills pipeline fields into them by hand.
 *
 * `PipelineStripConnected` additionally forwards the codec config (task 4.3,
 * UI-4) from `state` — `PipelineContext` only carries the *computed*
 * pipeline output, not the raw `fieldPipelines`/`chunkPipeline`/`interleaving`
 * config `stepWarnings` needs, so those four are passed as plain props
 * instead of being drilled through the context. */
function PipelineStripConnected({
  variables,
  fieldPipelines,
  chunkPipeline,
  interleaving,
}: {
  variables: Variable[];
  fieldPipelines: Record<string, CodecStep[]>;
  chunkPipeline: CodecStep[];
  interleaving: 'row' | 'column';
}) {
  const { stages, readResult, variableStats } = usePipelineContext();
  return (
    <PipelineStrip
      stages={stages}
      readResult={readResult}
      variableStats={variableStats}
      variables={variables}
      fieldPipelines={fieldPipelines}
      chunkPipeline={chunkPipeline}
      interleaving={interleaving}
    />
  );
}

function HoverBarConnected() {
  const { stages, stageSources } = usePipelineContext();
  return <HoverBar stages={stages} stageSources={stageSources} />;
}

export function App() {
  // GuideProvider wraps Header (toggle button), MainLayout (Sidebar section
  // highlight), and GuidePanel. The panel is a fixed-width flex sibling of
  // MainLayout's wrapper — NOT a third resizable panel, so the persisted
  // 'main-layout' panel-group id is untouched.
  return (
    <GuideProvider>
      <Header />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ErrorBoundary>
            <MainLayout />
          </ErrorBoundary>
        </div>
        <GuidePanel />
      </div>
    </GuideProvider>
  );
}
