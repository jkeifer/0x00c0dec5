import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { PipelineResult } from '../engine/pipelineCompute.ts';
import type { PipelineStage, VirtualFile, ReadFileResult, VariableStats, StageName } from '../types/pipeline.ts';
import type { ValueSources, ValueArray } from '../engine/layout.ts';

/**
 * PipelineContext (remediation-plan.md, Phase 3.9): carries the pipeline's
 * output plus the diff toggle — the values every viewer/StagePane needs but
 * that were previously drilled through ~10 props on each `<StagePane>` in
 * App.tsx (paneId/selectedStage/viewMode/onStageChange/onViewChange/
 * accentColor are genuinely per-pane and stay as props; everything else here
 * is identical for both panes).
 *
 * The value is split into two `useMemo`s in `PipelineProvider` — one for the
 * `PipelineResult` fields (already a single memoized object from
 * `usePipeline`) and one for `showDiff` + the derived `originalValues` alias
 * — so a `showDiff` toggle does not create a new object identity for the
 * pipeline fields, preserving task 3.2's memo split (viewers that only read
 * `stages`/`files`/etc. don't re-render just because `showDiff` flipped, and
 * vice versa for a component that only reads `showDiff`).
 */
export interface PipelineContextValue {
  stages: PipelineStage[];
  files: VirtualFile[];
  readResult: ReadFileResult;
  variableStats: Map<string, VariableStats>;
  /** D6: Values-stage source arrays, keyed by variable name. */
  logicalValues: Map<string, ValueArray>;
  /** D6: Typed-stage source arrays, keyed by variable name. */
  typedValues: Map<string, ValueArray>;
  /** Task 8 (perf plan): per-stage ValueSources for traceAt/flatGroupAt
   *  — see usePipeline.ts's buildStageSources. */
  stageSources: Map<StageName, ValueSources>;
  showDiff: boolean;
  /**
   * Alias of `logicalValues` (see App.tsx's prior inline comment, D6 Phase
   * 3.3): the Values stage's source arrays double as "the original values to
   * diff the Read stage's reconstruction against." Kept as a separately
   * named field because that's the semantic role consumers (StagePane's diff
   * computation) actually use it for — renaming call sites to `logicalValues`
   * there would obscure why the diff is being computed against it.
   */
  originalValues: Map<string, ValueArray>;
  /**
   * Task 13 (perf plan): true while the worker is computing a newer state
   * than the currently-rendered `pipeline` (stale-view UX — the previous
   * result stays rendered/interactive while this is true). Threaded through
   * context rather than prop-drilled, matching `showDiff`'s existing split-
   * memo pattern below.
   */
  computing: boolean;
}

const PipelineContext = createContext<PipelineContextValue | null>(null);

export function PipelineProvider({
  pipeline,
  showDiff,
  computing,
  children,
}: {
  pipeline: PipelineResult;
  showDiff: boolean;
  computing: boolean;
  children: ReactNode;
}) {
  // Split memo: `pipelinePart` changes only when `usePipeline`'s return value
  // changes; `value` recombines it with `showDiff` cheaply (object spread of
  // an already-stable reference) so a showDiff-only toggle doesn't force
  // downstream consumers to treat the whole pipeline as new, and a pipeline
  // recompute doesn't spuriously invalidate showDiff-only consumers either.
  const pipelinePart = useMemo(
    () => ({
      stages: pipeline.stages,
      files: pipeline.files,
      readResult: pipeline.readResult,
      variableStats: pipeline.variableStats,
      logicalValues: pipeline.logicalValues,
      typedValues: pipeline.typedValues,
      stageSources: pipeline.stageSources,
      originalValues: pipeline.logicalValues,
    }),
    [pipeline],
  );

  const value = useMemo<PipelineContextValue>(
    () => ({ ...pipelinePart, showDiff, computing }),
    [pipelinePart, showDiff, computing],
  );

  return <PipelineContext.Provider value={value}>{children}</PipelineContext.Provider>;
}

export function usePipelineContext(): PipelineContextValue {
  const ctx = useContext(PipelineContext);
  if (!ctx) {
    throw new Error('usePipelineContext must be used within a PipelineProvider');
  }
  return ctx;
}
