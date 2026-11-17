import { DELAY_INPUTS, delayScenes, renderDelay } from '../../../../test-utils/delay-render';
import { dB } from '../../../../test-utils/measures';

// The delay against the native nodes it replaced (dsp/measurements/delay.json: scripts/delay-native/run.mjs renders
// that graph in Chromium): the same input through the core, the difference under the rendered signal

const energy = (data: Float32Array) => data.reduce((sum, value) => sum + value * value, 0);

// the difference of two renders under the first one, dB (both channels)
const under = (a: Float32Array[], b: Float32Array[]) => {
  let signal = 0;
  let difference = 0;
  a.forEach((channel, c) => {
    signal += energy(channel);
    difference += energy(channel.map((value, i) => value - b[c][i]));
  });
  return dB(Math.sqrt(difference / signal));
};

// what a scene may differ by: nothing moves (the sums in f32 as the nodes have them, the filter in doubles), a
// knob glides (the gains linear in a block where an AudioParam follows its pole every sample)
const LIMITS: Record<string, number> = { 'time glide': -55, 'knobs glide': -55 };
const STILL = -100;

describe('the delay of the core is the delay of the native nodes', () => {
  const scenes = delayScenes();

  it('has the scenes of the render', () => {
    expect(scenes.map(({ name }) => name)).toEqual([
      'normal',
      'fractional',
      'ping-pong',
      'pan right',
      'pan left',
      'narrow filter',
      'low filter',
      '48 kHz',
      'time glide',
      'knobs glide',
    ]);
  });

  it.each(scenes.map((scene) => [scene.name, scene] as const))('%s', (name, scene) => {
    const input = DELAY_INPUTS[scene.kind](scene.frames);
    const changes = scene.changes.map(({ frame, params }) => ({ at: frame, params }));
    const { left, right } = renderDelay(scene.params, input, changes, scene.rate);
    expect(energy(scene.left) + energy(scene.right)).toBeGreaterThan(0.001);
    expect(under([scene.left, scene.right], [left, right])).toBeLessThan(LIMITS[name] ?? STILL);
  });
});
