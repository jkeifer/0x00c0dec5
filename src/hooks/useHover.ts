import { createContext, useContext, useState, useCallback, type ReactNode, createElement } from 'react';

interface HoverContextValue {
  hoveredTraceId: string | null;
  hoverSource: 'left' | 'right' | null;
  setHover: (traceId: string | null, source: 'left' | 'right') => void;
  clearHover: () => void;
}

const HoverContext = createContext<HoverContextValue | null>(null);

export function HoverProvider({ children }: { children: ReactNode }) {
  const [hoveredTraceId, setHoveredTraceId] = useState<string | null>(null);
  const [hoverSource, setHoverSource] = useState<'left' | 'right' | null>(null);

  const setHover = useCallback((traceId: string | null, source: 'left' | 'right') => {
    setHoveredTraceId(traceId);
    setHoverSource(traceId ? source : null);
  }, []);

  const clearHover = useCallback(() => {
    setHoveredTraceId(null);
    setHoverSource(null);
  }, []);

  return createElement(
    HoverContext.Provider,
    { value: { hoveredTraceId, hoverSource, setHover, clearHover } },
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
