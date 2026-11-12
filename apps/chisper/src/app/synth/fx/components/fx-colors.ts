import { FxType } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';

// the effect's own color in the effects list: the lamp, the icon and the left border of an added effect
export const FX_COLORS: Record<FxType, string> = {
  distortion: theme.colors.red,
  chorus: theme.colors.fourthAccent,
  delay: theme.colors.secondAccent,
  compressor: theme.colors.thirdAccent,
  reverb: theme.colors.accent,
};
