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
