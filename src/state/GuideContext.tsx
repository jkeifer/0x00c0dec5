import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { loadUiPrefs, saveUiPrefs } from './uiPrefs.ts';
import { STEPS } from '../components/guide/steps.ts';

/**
 * GuideContext (plan Phase 5): the Guide panel's open/collapsed/step state,
 * mirroring PipelineContext's provider pattern. Lives in ui-prefs storage
 * (never AppState/config) so it survives Clear, presets, and model switches.
 *
 * Presenter mode is just this state pre-set: `?presenter` in the URL starts
 * the guide open but collapsed to the slim rail.
 */
export interface GuideContextValue {
  open: boolean;
  collapsed: boolean;
  stepIndex: number;
  /** Sidebar section slug to highlight (null when closed or on a bookend step). */
  activeSection: string | null;
  next: () => void;
  back: () => void;
  goTo: (index: number) => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleOpen: () => void;
}

const noop = () => {};

/** Default value so components (Sidebar, Header) render without a provider —
 * e.g. in isolated tests. */
const DEFAULT_VALUE: GuideContextValue = {
  open: false,
  collapsed: false,
  stepIndex: 0,
  activeSection: null,
  next: noop,
  back: noop,
  goTo: noop,
  setCollapsed: noop,
  toggleOpen: noop,
};

const GuideContext = createContext<GuideContextValue>(DEFAULT_VALUE);

interface GuideState {
  open: boolean;
  collapsed: boolean;
  stepIndex: number;
}

function initGuideState(): GuideState {
  const prefs = loadUiPrefs();
  // loadUiPrefs guarantees a non-negative integer but not an upper bound.
  const stepIndex = Math.min(prefs.guideStep, STEPS.length - 1);
  // ?presenter wins over stored prefs: open, collapsed to the rail.
  if (new URLSearchParams(location.search).has('presenter')) {
    return { open: true, collapsed: true, stepIndex };
  }
  return { open: prefs.guideOpen, collapsed: prefs.guideCollapsed, stepIndex };
}

export function GuideProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GuideState>(initGuideState);

  const value = useMemo<GuideContextValue>(() => {
    function update(patch: Partial<GuideState>) {
      const next = { ...state, ...patch };
      saveUiPrefs({
        guideOpen: next.open,
        guideCollapsed: next.collapsed,
        guideStep: next.stepIndex,
      });
      setState(next);
    }
    return {
      ...state,
      activeSection: state.open ? STEPS[state.stepIndex].section : null,
      next: () => update({ stepIndex: Math.min(state.stepIndex + 1, STEPS.length - 1) }),
      back: () => update({ stepIndex: Math.max(state.stepIndex - 1, 0) }),
      goTo: (index) =>
        update({ stepIndex: Math.max(0, Math.min(index, STEPS.length - 1)) }),
      setCollapsed: (collapsed) => update({ collapsed }),
      toggleOpen: () => update({ open: !state.open }),
    };
  }, [state]);

  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook lives with its provider by design; losing fast-refresh here is acceptable
export function useGuide(): GuideContextValue {
  return useContext(GuideContext);
}
