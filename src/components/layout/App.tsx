import { Panel, Group, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useAppState } from '../../state/useAppState.ts';
import { usePipeline } from '../../hooks/usePipeline.ts';
import { colors, fontSizes, spacing } from '../../theme.ts';
import { Header } from './Header.tsx';
import { Sidebar } from './Sidebar.tsx';
import { PipelineStrip } from './PipelineStrip.tsx';
import { StagePane } from '../viewers/StagePane.tsx';

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
          {/* HoverInfoBar placeholder */}
          <div
            style={{
              height: 24,
              display: 'flex',
              alignItems: 'center',
              padding: `0 ${spacing.md}px`,
              fontSize: fontSizes.xs,
              color: colors.textTertiary,
              background: colors.bg,
              borderBottom: `1px solid ${colors.borderSubtle}`,
              flexShrink: 0,
            }}
          >
            Hover a value to trace it
          </div>
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
