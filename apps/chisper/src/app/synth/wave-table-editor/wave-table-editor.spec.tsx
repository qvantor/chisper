import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createOscillator } from '../../../test-utils/models';
import { ascii, chunk, data, fmt, riff } from '../../../test-utils/wav-file';
import { OscillatorContext } from '../oscillator/hooks';
import WaveTableEditor from './index';

const bytes = riff(fmt(), chunk('clm ', ascii('<!>2048 00000000')), data(new Array(2048 * 2).fill(0.25)));
// (jsdom's File has no arrayBuffer)
const table = Object.assign(new File([bytes], 'Pad.wav'), { arrayBuffer: () => Promise.resolve(bytes) });

describe('the wavetable editor', () => {
  it('shows the waves of a WAV wavetable on the drawing tab once it is taken on the Audio file tab', async () => {
    const oscillator = createOscillator();
    const user = userEvent.setup();
    render(
      <OscillatorContext.Provider value={oscillator}>
        <WaveTableEditor />
      </OscillatorContext.Provider>
    );
    expect(screen.getByRole('tab', { name: 'Manual' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'Audio file' }));
    await user.upload(screen.getByLabelText('Audio or wavetable file'), table);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Manual' })).toHaveAttribute('aria-selected', 'true')
    );
    expect(oscillator[0].$waveTable.value).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Add a wave' })).toBeInTheDocument();
  });
});
