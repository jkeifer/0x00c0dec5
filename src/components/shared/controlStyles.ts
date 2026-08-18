import { colors, fontSizes, radii, spacing } from '../../theme.ts';

/**
 * Shared text-input/select/button style (task 3.10, remediation-plan.md
 * §1.8): six config components (`SchemaEditor`, `ChunkConfig`, `WriteConfig`,
 * `MetadataEditor`, `CodecPipelineEditor`, `TypeAssignConfig`) each declared
 * an identical `inputStyle` constant — identical except `TypeAssignConfig`
 * used `fontSizes.xs` instead of `fontSizes.sm`, hence the optional override.
 */
export function inputStyle(fontSize: number = fontSizes.sm): React.CSSProperties {
  return {
    background: colors.surfaceInput,
    border: `1px solid ${colors.border}`,
    borderRadius: radii.sm,
    fontSize,
    color: colors.textPrimary,
    padding: `${spacing.xs}px ${spacing.sm}px`,
    outline: 'none',
    fontFamily: 'inherit',
  };
}

/**
 * UI-15: number param inputs used `parseFloat(v) || 0`, so clearing the
 * field (or typing something non-numeric mid-edit) set the param to 0 even
 * when the param's `min` is 1 (e.g. byte-shuffle's `elementSize`) — an
 * out-of-range value silently reached the pipeline. Clamp into [min, max]
 * instead, falling back to `min` (if set) or the param's own default when
 * the input doesn't parse. Lives here (not in CodecPipelineEditor, its
 * original home) because component files may only export components
 * (react-refresh/only-export-components).
 */
export function clampParamValue(raw: string, min: number | undefined, max: number | undefined, fallback: number): number {
  const parsed = parseFloat(raw);
  let value = Number.isNaN(parsed) ? fallback : parsed;
  if (min !== undefined && value < min) value = min;
  if (max !== undefined && value > max) value = max;
  return value;
}
