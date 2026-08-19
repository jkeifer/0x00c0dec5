import { useRef, useState } from 'react';
import { Panel, Group, Separator, useDefaultLayout } from 'react-resizable-panels';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { useAppState } from '../../state/useAppState.ts';
import { useWorkerPipeline } from '../../hooks/useWorkerPipeline.ts';
import { PipelineProvider, usePipelineContext } from '../../state/PipelineContext.tsx';
import { colors, fonts, fontSizes } from '../../theme.ts';
import { Header } from './Header.tsx';
import { RuntimeBanner } from './RuntimeBanner.tsx';
import { ComputeErrorBanner } from './ComputeErrorBanner.tsx';
import { Sidebar } from './Sidebar.tsx';
import { PipelineStrip } from './PipelineStrip.tsx';
import { StagePane } from '../viewers/StagePane.tsx';
import { HoverBar } from '../shared/HoverBar.tsx';
import { ErrorBoundary } from '../shared/ErrorBoundary.tsx';
import { GuideProvider } from '../../state/GuideContext.tsx';
import { GuidePanel } from '../guide/GuidePanel.tsx';
import type { PipelineResult } from '../../engine/pipelineCompute.ts';
import type { RuntimeState } from '../../worker/client.ts';

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

function MainLayout({ result, computing, bootError, runtimeStatus }: {
  result: PipelineResult | null;
  computing: boolean;
  bootError: string | null;
  runtimeStatus: RuntimeState['status'];
}) {
  const { state, dispatch } = useAppState();

  const mainPersist = useDefaultLayout({ id: 'main-layout' });
  const panesPersist = useDefaultLayout({ id: 'panes-layout' });

  // Task 2 (ri plan): collapsible sidebar + comparison panes, built on
  // react-resizable-panels v4's Panel collapsible/collapsedSize + imperative
  // panelRef (collapse()/expand()/isCollapsed()). There is no onCollapse/
  // onExpand callback in this version's API (checked
  // node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts) —
  // only onResize(panelSize, id, prevPanelSize), so collapsed state is
  // derived there by asking the panelRef whether it's collapsed after the
  // resize settles. Persistence of sizes (including collapsed) is already
  // covered by useDefaultLayout above — no parallel persistence added here.
  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const leftPaneRef = useRef<PanelImperativeHandle | null>(null);
  const rightPaneRef = useRef<PanelImperativeHandle | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Task 13 (perf plan): before the worker's first result ever arrives there
  // is nothing to render — PipelineProvider and every consumer below it
  // assume a non-null PipelineResult. Once `result` exists this branch never
  // re-triggers (stale-view UX keeps the last-good result mounted while a
  // later `computing` pass runs in the background).
  if (result === null) {
    return <BootScreen error={bootError} />;
  }

  // Stale-view consistency: while a newer state computes (or is refused by
  // the hard cap), the panes keep showing `result` — so they must be laid out
  // with the config that result was computed FROM, not the live state. Live
  // state here would size grids/tables to a shape whose values don't exist
  // yet (a committed-but-refused 2-billion-wide shape = frozen canvas).
  const viewConfig = result.computedFrom ?? {
    shape: state.shape,
    chunkShape: state.chunkShape,
    variables: state.variables,
    interleaving: state.interleaving,
  };

  function toggleSidebar() {
    if (sidebarRef.current?.isCollapsed()) {
      sidebarRef.current.expand();
    } else {
      sidebarRef.current?.collapse();
    }
  }

  // Guard: the two comparison panes must never both be collapsed. Expand the
  // other one first when collapsing one while the other is already collapsed.
  function toggleLeftPane() {
    if (leftPaneRef.current?.isCollapsed()) {
      leftPaneRef.current.expand();
    } else {
      if (rightPaneRef.current?.isCollapsed()) rightPaneRef.current.expand();
      leftPaneRef.current?.collapse();
    }
  }

  function toggleRightPane() {
    if (rightPaneRef.current?.isCollapsed()) {
      rightPaneRef.current.expand();
    } else {
      if (leftPaneRef.current?.isCollapsed()) leftPaneRef.current.expand();
      rightPaneRef.current?.collapse();
    }
  }

  return (
    <PipelineProvider pipeline={result} computing={computing} runtimeStatus={runtimeStatus}>
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
        <Panel
          id="sidebar"
          defaultSize="25%"
          minSize="200px"
          maxSize="35%"
          collapsible
          collapsedSize="36px"
          panelRef={sidebarRef}
          onResize={() => setSidebarCollapsed(!!sidebarRef.current?.isCollapsed())}
        >
          <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar} />
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
            <PipelineStripConnected codecWarnings={result.codecWarnings} />
            <HoverBarConnected />
            <Group
              orientation="horizontal"
              defaultLayout={panesPersist.defaultLayout}
              onLayoutChanged={panesPersist.onLayoutChanged}
              style={{ flex: 1 }}
            >
              <Panel
                id="left-pane"
                defaultSize="50%"
                minSize="5%"
                collapsible
                collapsedSize="36px"
                panelRef={leftPaneRef}
                onResize={() => setLeftCollapsed(!!leftPaneRef.current?.isCollapsed())}
              >
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
                  variables={viewConfig.variables}
                  shape={viewConfig.shape}
                  chunkShape={viewConfig.chunkShape}
                  interleaving={viewConfig.interleaving}
                  collapsed={leftCollapsed}
                  onToggleCollapse={toggleLeftPane}
                />
              </Panel>
              <Separator className="resize-handle" />
              <Panel
                id="right-pane"
                defaultSize="50%"
                minSize="5%"
                collapsible
                collapsedSize="36px"
                panelRef={rightPaneRef}
                onResize={() => setRightCollapsed(!!rightPaneRef.current?.isCollapsed())}
              >
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
                  variables={viewConfig.variables}
                  shape={viewConfig.shape}
                  chunkShape={viewConfig.chunkShape}
                  interleaving={viewConfig.interleaving}
                  collapsed={rightCollapsed}
                  onToggleCollapse={toggleRightPane}
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
 * `PipelineStripConnected` additionally forwards `codecWarnings` (S1,
 * overhaul-plan.md F1/F22): `PipelineContext` only carries the pipeline
 * output that's identical for both StagePanes, so `codecWarnings` — which
 * comes from the same `PipelineResult` as `stages` but isn't otherwise
 * needed by anything under `PipelineProvider` — is passed as a plain prop
 * from `MainLayout`'s `result` rather than being added to the context. */
function PipelineStripConnected({ codecWarnings }: { codecWarnings: string[] }) {
  const { stages, readResult, variableStats, computing } = usePipelineContext();
  return (
    <PipelineStrip
      stages={stages}
      readResult={readResult}
      variableStats={variableStats}
      codecWarnings={codecWarnings}
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
      <RuntimeBanner runtime={diagnostics.runtime} />
      {/* F4: a mid-session ok:false must stay visible past the boot screen,
       * which only ever sees the FIRST error (result stays null until the
       * first success). Gated on result!==null so a boot-time failure keeps
       * showing through BootScreen instead of doubling up here. */}
      {result !== null && <ComputeErrorBanner diagnostics={diagnostics} />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ErrorBoundary>
            <MainLayout
              result={result}
              computing={computing}
              bootError={result === null ? diagnostics.lastError : null}
              runtimeStatus={diagnostics.runtime.status}
            />
          </ErrorBoundary>
        </div>
        <GuidePanel />
      </div>
    </GuideProvider>
  );
}
