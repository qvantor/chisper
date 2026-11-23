// first: the Math of JS as jsmath (test-utils/js-math.ts): the levels of the warp worked out as the core does
import '../../../test-utils/js-math';
import { warp } from '@chisper/math';
import { WARP_MODES } from '@chisper/preset-schema';
import { seeded } from '../../../test-utils/seeded';
import { wasmCore } from '../../../test-utils/wasm';
import type { CoreExports } from '../common/wasm/wasm-core';

// The map of the Warp the chart draws (libs/math/src/oscillator/warp.ts) against the one the voices play (warp.rs of
// dsp/wavetable-osc, osc_warp of its perf build): the same operations in f32, so the same bits. A change of one is
// made in the other; warp-measured.spec holds the map to the Audio Unit

interface WarpExports extends CoreExports {
  osc_command: () => number;
  osc_warp: (mode: number, knob: number, count: number) => void;
}

const core = wasmCore<WarpExports>('engine');
const CYCLE = 2 ** 32;
const MODES = [warp.WARP_BEND_UP, warp.WARP_BEND_DOWN, warp.WARP_BEND_BOTH, warp.WARP_PWM];

// the phases through the map of the core, its param, levels and the seconds of the one-pole of its knob after them
const coreWarp = (mode: number, knob: number, phases: number[]) => {
  const command = new Float64Array(core.memory.buffer, core.osc_command() >>> 0, phases.length + 3);
  command.set(phases);
  core.osc_warp(mode, knob, phases.length);
  return [...command];
};

const chartWarp = (mode: number, knob: number, phases: number[]) => {
  const param = warp.warpParam(mode, knob);
  const mapped = warp.warpNeutral(mode, param)
    ? phases
    : phases.map((phase) => warp.warpSample(warp.warpBends(mode), param, phase));
  return [...mapped, param, warp.warpLevels(mode, param), warp.WARP_SMOOTHING];
};

describe('the warp of the chart', () => {
  it('has the modes of the presets in their order, Off first', () => {
    expect(WARP_MODES).toEqual(['off', 'bend+', 'bend-', 'bend+-', 'pwm']);
    expect([warp.WARP_OFF, ...MODES]).toEqual(WARP_MODES.map((_, index) => index));
  });

  it.each(MODES)('maps every phase as the core does (mode %i)', (mode) => {
    const random = seeded(mode);
    // the phases of a cycle in steps, those around its edges and its middle, and at random
    const phases = [
      ...Array.from({ length: 1024 }, (_, j) => Math.floor((j * CYCLE) / 1024)),
      0,
      1,
      2 ** 31 - 1,
      2 ** 31,
      2 ** 31 + 1,
      CYCLE - 1,
      ...Array.from({ length: 1024 }, () => Math.floor(random() * CYCLE)),
    ];
    for (const knob of [0, 0.001, 0.1, 0.25, 0.5, 0.5001, 0.75, 0.9, 0.999, 1, random(), random()]) {
      expect(chartWarp(mode, knob, phases)).toEqual(coreWarp(mode, knob, phases));
    }
  });

  it('leaves the phases of Off as they are, whatever the knob', () => {
    const phases = [0, 12345, 2 ** 31, CYCLE - 1];
    expect(coreWarp(warp.WARP_OFF, 0.7, phases)).toEqual([...phases, 0, 0, warp.WARP_SMOOTHING]);
    expect(chartWarp(warp.WARP_OFF, 0.7, phases)).toEqual([...phases, 0, 0, warp.WARP_SMOOTHING]);
  });
});
