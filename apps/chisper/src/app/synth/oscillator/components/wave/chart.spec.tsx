import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { HandleModulation } from '@chisper/ui-kit';
import { drawn, svgPath, withElementSize } from '@chisper/ui-kit/test-utils';
import { createOscillator } from '../../../../../test-utils/models';
import { OscillatorContext } from '../../hooks';
import { Chart } from './chart';

// the chart pads x by -1 and y by 2: the wave spans 400 × 100
const [WIDTH, HEIGHT] = [400, 100];

// a frame of 8 samples (one cycle): the chart draws sample j at 50·j px, a value v at 50 - 50·v px
const FRAME = [-1, -0.5, 0, 0.5, 1, 0.5, 0, -0.5];

const waveLine = () =>
  svgPath(drawn(screen.getByTestId('wave-line')).find(({ op }) => op === 'stroke') ?? { points: [] });

const setup = (warpModulations?: HandleModulation[]) => {
  const oscillator = createOscillator();
  const [, actions] = oscillator;
  act(() => actions.setWaveTable([FRAME]));
  render(
    <OscillatorContext.Provider value={oscillator}>
      <Chart warpModulations={warpModulations} />
    </OscillatorContext.Provider>
  );
  return actions;
};

describe('the wave of the chart through the Warp', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withElementSize(WIDTH - 2, HEIGHT + 4);
  });
  afterEach(() => restore());

  it('draws the frame as it is while the Warp is Off, whatever its knob', () => {
    const actions = setup();
    act(() => actions.setWarp(0.8));
    expect(waveLine()).toContain('L0,100L50,75L100,50L150,25L200,0L250,25L300,50L350,75L400,100');
  });

  it('draws the frame as the voices read it: PWM squeezes it to the left, its first sample over the rest', () => {
    const actions = setup();
    act(() => {
      actions.setWarpMode(4);
      actions.setWarp(0.5);
    });
    // sample j at the phase 2j / 8 of the frame until it reaches the end, then its sample 0
    expect(waveLine()).toContain('L0,100L50,50L100,0L150,50L200,100L250,100L300,100L350,100L400,100');
  });

  it('draws again as the knob or the mode moves, the frame as it is at a neutral knob', () => {
    const actions = setup();
    act(() => {
      actions.setWarpMode(3);
      actions.setWarp(0.1);
    });
    const bent = waveLine();
    expect(bent).not.toContain('L0,100L50,75L100,50L150,25L200,0');
    // Bend +/- at 0.5: no warp
    act(() => actions.setWarp(0.5));
    expect(waveLine()).toContain('L0,100L50,75L100,50L150,25L200,0L250,25L300,50L350,75L400,100');
    act(() => actions.setWarpMode(1));
    expect(waveLine()).not.toBe(bent);
  });

  describe('while a route moves the knob', () => {
    let now = 0;
    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(performance, 'now').mockImplementation(() => now);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      jest.useRealTimers();
    });
    const tick = () =>
      act(() => {
        now += 16;
        jest.advanceTimersByTime(16);
      });

    it('draws the knob where the voices read it: the routes through the one-pole of the Warp', () => {
      let level = 0;
      const route = { id: 'lfo1', color: 'red', amount: 0.5, level: () => level, live: true };
      const actions = setup([route]);
      act(() => actions.setWarpMode(4));
      // PWM at 0: the frame as it is
      expect(waveLine()).toContain('L0,100L50,75L100,50L150,25L200,0L250,25L300,50L350,75L400,100');
      // the route to 0.5 at once: a frame later PWM short of it, then there
      level = 1;
      tick();
      const between = waveLine();
      expect(between).not.toContain('L0,100L50,75L100,50L150,25L200,0L250,25');
      expect(between).not.toContain('L0,100L50,50L100,0L150,50L200,100L250,100L300,100L350,100L400,100');
      for (let i = 0; i < 10; i++) tick();
      expect(waveLine()).toContain('L0,100L50,50L100,0L150,50L200,100L250,100L300,100L350,100L400,100');
    });
  });
});
