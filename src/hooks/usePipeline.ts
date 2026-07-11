// Task 13 (perf plan): the pure, React-free pipeline compute code moved to
// src/engine/pipelineCompute.ts so pipeline.worker.ts's bundle doesn't pull
// react in (it previously imported computePipelineStages from this file,
// which imported `useMemo` at module scope). Every existing import path
// (`../hooks/usePipeline.ts` / `../../hooks/usePipeline.ts`) keeps working
// via this re-export — tests, scripts/profile.ts, scripts/gen-presets.ts,
// and the worker were all verified (grep) to import only the pure functions/
// types re-exported here, never the old `usePipeline` hook itself (which is
// deleted — see src/hooks/useWorkerPipeline.ts for its replacement).
export * from '../engine/pipelineCompute.ts';
