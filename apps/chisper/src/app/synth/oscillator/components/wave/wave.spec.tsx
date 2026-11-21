import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { recordAnalytics } from '../../../../../test-utils/analytics';
import { createOscillator, stopModels } from '../../../../../test-utils/models';
import { OscillatorContext } from '../../hooks';
import { Wave } from './index';

// (the block of the wave alone: its chart, its strips, its status and the editor are other specs')
jest.mock('./chart', () => ({ Chart: () => null }));
jest.mock('./pitch-info', () => ({ PitchInfo: () => null }));
jest.mock('../oscillator-status', () => ({ OscillatorStatus: () => null }));
jest.mock('../../../wave-table-editor', () => ({ __esModule: true, default: () => <div>The editor</div> }));

afterEach(() => stopModels());

describe('Wave', () => {
  it('the editor of the table opened is a use of it (closed, none)', () => {
    const { features } = recordAnalytics();
    render(
      <OscillatorContext.Provider value={createOscillator()}>
        <Wave target='osc1' onUnisonActiveChange={() => undefined} />
      </OscillatorContext.Provider>
    );
    fireEvent.click(screen.getByRole('img', { name: 'edit' }));
    expect(screen.getByText('The editor')).toBeTruthy();
    fireEvent.click(screen.getByRole('img', { name: 'close' }));
    expect(screen.queryByText('The editor')).toBeNull();
    expect(features()).toEqual(['wavetable_editor:open']);
  });
});
