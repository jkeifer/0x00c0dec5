import { createContext, useContext, useState, useCallback, useMemo, type ReactNode, createElement } from 'react';

interface HoverState {
  hoveredTraceId: string | null;
  hoveredChunkId: string | null;
  hoverSource: 'left' | 'right' | null;
}

interface HoverContextValue extends HoverState {
  setHover: (traceId: string | null, chunkId: string | null, source: 'left' | 'right') => void;
  clearHover: () => void;
}

const INITIAL_STATE: HoverState = {
  hoveredTraceId: null,
  hoveredChunkId: null,
  hoverSource: null,
};

const HoverContext = createContext<HoverContextValue | null>(null);

export function HoverProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HoverState>(INITIAL_STATE);

  const setHover = useCallback((traceId: string | null, chunkId: string | null, source: 'left' | 'right') => {
    setState({
      hoveredTraceId: traceId,
      hoveredChunkId: chunkId,
      hoverSource: traceId ? source : null,
    });
  }, []);

  const clearHover = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const value = useMemo<HoverContextValue>(
    () => ({ ...state, setHover, clearHover }),
    [state, setHover, clearHover],
  );

  return createElement(
    HoverContext.Provider,
    { value },
    children,
  );
}

export function useHover(): HoverContextValue {
  const ctx = useContext(HoverContext);
  if (!ctx) {
    throw new Error('useHover must be used within a HoverProvider');
  }
  return ctx;
}
