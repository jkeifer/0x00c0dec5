import { createContext, useContext, useState, type ReactNode, createElement } from 'react';

interface HoverContextValue {
  hoveredTraceId: string | null;
  setHoveredTraceId: (id: string | null) => void;
}

const HoverContext = createContext<HoverContextValue | null>(null);

export function HoverProvider({ children }: { children: ReactNode }) {
  const [hoveredTraceId, setHoveredTraceId] = useState<string | null>(null);

  return createElement(
    HoverContext.Provider,
    { value: { hoveredTraceId, setHoveredTraceId } },
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
