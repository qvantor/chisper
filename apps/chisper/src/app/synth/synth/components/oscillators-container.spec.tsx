import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { recordAnalytics } from '../../../../test-utils/analytics';
import { createOscillator, stopModels } from '../../../../test-utils/models';
import { Oscillator1Context, Oscillator2Context } from '../../common/modules/oscillator';
import { Oscillator1, Oscillator2 } from './oscillators-container';

// (the section alone: its oscillator is another spec's)
jest.mock('../../oscillator', () => ({ Oscillator: () => null }));

afterEach(() => stopModels());

describe('the sections of the oscillators', () => {
  it('OSC 2 turned on is a use (not off, not OSC 1: every patch has it)', () => {
    const osc1 = createOscillator(undefined, 'osc1', { active: true, initialWavePath: ['default'] });
    const osc2 = createOscillator(undefined, 'osc2', { active: false, initialWavePath: ['default'] });
    const { features } = recordAnalytics();
    render(
      <Oscillator1Context.Provider value={osc1}>
        <Oscillator2Context.Provider value={osc2}>
          <Oscillator1 />
          <Oscillator2 />
        </Oscillator2Context.Provider>
      </Oscillator1Context.Provider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Osc 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Osc 1' }));
    expect(features()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Osc 2' }));
    expect(osc2[0].$active.value).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Osc 2' }));
    expect(osc2[0].$active.value).toBe(false);
    expect(features()).toEqual(['osc2']);
  });
});
