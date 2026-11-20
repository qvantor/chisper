import { getSnapshot } from '../../../app';
import type { NoiseModel, OscillatorModel } from '../../common/modules';
import type { RenderSound } from './render-models';

// what an oscillator of the page plays: its table as it is (drawn or edited too), its unison shape
const oscillatorOf = ({ $waveTable, $morph, $unisonShape }: OscillatorModel) => ({
  frames: $waveTable.value.map(($frame) => $frame.value),
  morph: $morph.value,
  unisonShape: $unisonShape.value,
});

// The sound of the page now, as a render plays it (render-models.ts): the snapshot of its models, the tempo of its
// field, the tables and the sample of the noise they hold (no download: a table may be drawn), its master gain
export const pageSound = (
  [osc1, osc2]: [OscillatorModel, OscillatorModel],
  noise: NoiseModel,
  bpm: number,
  masterGain: number
): RenderSound => ({
  snapshot: getSnapshot(),
  bpm,
  oscillators: [oscillatorOf(osc1), oscillatorOf(osc2)],
  noise: noise.$sample.value,
  masterGain,
});

// whether the sound of the page can't be rendered yet: a source that is on still loading its table or its sample
// (the noise holds the sample before meanwhile: a render would play it under the path of the new one; a load that
// failed leaves the one before on the page, a render takes it too; none before: the page plays no noise, nor does
// the render, render-models.ts)
export const soundLoading = ([osc1, osc2]: [OscillatorModel, OscillatorModel], noise: NoiseModel) =>
  [osc1, osc2].some(({ $active, $waveTableLoading }) => $active.value && $waveTableLoading.value) ||
  (noise.$active.value && noise.$sampleLoading.value);
