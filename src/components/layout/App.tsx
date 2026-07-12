import { Panel, Group, Separator, useDefaultLayout } from 'react-resizable-panels';
import type { Variable } from '../../types/state.ts';
import type { CodecStep } from '../../types/codecs.ts';
import { useAppState } from '../../state/useAppState.ts';
import { useWorkerPipeline } from '../../hooks/useWorkerPipeline.ts';
import { PipelineProvider, usePipelineContext } from '../../state/PipelineContext.tsx';
import { colors, fonts, fontSizes } from '../../theme.ts';
import { Header } from './Header.tsx';
import { Sidebar } from './Sidebar.tsx';
import { PipelineStrip } from './PipelineStrip.tsx';
import { StagePane } from '../viewers/StagePane.tsx';
import { HoverBar } from '../shared/HoverBar.tsx';
import { ErrorBoundary } from '../shared/ErrorBoundary.tsx';
import { GuideProvider } from '../../state/GuideContext.tsx';
import { GuidePanel } from '../guide/GuidePanel.tsx';
import type { PipelineResult } from '../../engine/pipelineCompute.ts';

/** Shown while `result` is still null. PERF-1: an ok:false FIRST compute used
 * to leave the "starting…" screen up forever (the stale-view design has no
 * last-good result to fall back to, and the error only reached the About
 * modal's diagnostics, unreachable behind this screen) — so a boot-time
 * `lastError` renders the error itself, with the Header's Clear button (still
 * mounted above this screen) as the recovery path. */
export function BootScreen({ error }: { error: string | null }) {
  return (
    <div
      data-testid={error === null ? 'pipeline-booting' : 'pipeline-boot-error'}
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'center',
        color: colors.textSecondary,
        fontFamily: fonts.mono,
        fontSize: fontSizes.md,
        padding: 24,
        textAlign: 'center',
      }}
    >
      {error === null ? (
        'starting…'
      ) : (
        <>
          <div style={{ color: colors.error }}>pipeline failed to start</div>
          <div style={{ fontSize: fontSizes.sm }}>{error}</div>
          <div style={{ fontSize: fontSizes.sm }}>
            Use the Clear button above to reset the configuration.
          </div>
        </>
      )}
    </div>
  );
}

function MainLayout({ result, computing, bootError }: {
  result: PipelineResult | null;
  computing: boolean;
  bootError: string | null;
}) {
  const { state, dispatch } = useAppState();

  const mainPersist = useDefaultLayout({ id: 'main-layout' });
  const panesPersist = useDefaultLayout({ id: 'panes-layout' });

  // Task 13 (perf plan): before the worker's first result ever arrives there
  // is nothing to render — PipelineProvider and every consumer below it
  // assume a non-null PipelineResult. Once `result` exists this branch never
  // re-triggers (stale-view UX keeps the last-good result mounted while a
  // later `computing` pass runs in the background).
  if (result === null) {
    return <BootScreen error={bootError} />;
  }

  return (
    <PipelineProvider pipeline={result} showDiff={state.ui.showDiff} computing={computing}>
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
  const { stages, readResult, variableStats, computing } = usePipelineContext();
  return (
    <PipelineStrip
      stages={stages}
      readResult={readResult}
      variableStats={variableStats}
      variables={variables}
      fieldPipelines={fieldPipelines}
      chunkPipeline={chunkPipeline}
      interleaving={interleaving}
      computing={computing}
    />
  );
}

function HoverBarConnected() {
  const { stages, stageSources } = usePipelineContext();
  return <HoverBar stages={stages} stageSources={stageSources} />;
}

export function App() {
  // Task 13 (perf plan): the worker-backed pipeline hook is called once here
  // (not inside MainLayout) so App can hand `diagnostics` to Header as a prop
  // (for Task 14's About modal) without Header reaching into the hook itself.
  const { state } = useAppState();
  const { result, computing, diagnostics } = useWorkerPipeline(state);

  // GuideProvider wraps Header (toggle button), MainLayout (Sidebar section
  // highlight), and GuidePanel. The panel is a fixed-width flex sibling of
  // MainLayout's wrapper — NOT a third resizable panel, so the persisted
  // 'main-layout' panel-group id is untouched.
  return (
    <GuideProvider>
      <Header diagnostics={diagnostics} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ErrorBoundary>
            <MainLayout
              result={result}
              computing={computing}
              bootError={result === null ? diagnostics.lastError : null}
            />
          </ErrorBoundary>
        </div>
        <GuidePanel />
      </div>
    </GuideProvider>
  );
}
