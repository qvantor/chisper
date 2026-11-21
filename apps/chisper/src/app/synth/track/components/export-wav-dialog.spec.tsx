import React from 'react';
import { BehaviorSubject } from 'rxjs';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import toast from 'react-hot-toast';
import { CLIP_BAR, CLIP_PPQ } from '@chisper/preset-schema';
import { getSnapshot } from '../../../app';
import { UPDATED } from '../../../common/services';
import { PresetsContext } from '../../../presets';
import { recordAnalytics } from '../../../../test-utils/analytics';
import { createSynth, createTrack, stopModels } from '../../../../test-utils/models';
import { InputControllerContext } from '../../common/modules/input-controller';
import { NoiseContext } from '../../common/modules/noise';
import { Oscillator1Context, Oscillator2Context } from '../../common/modules/oscillator';
import { SynthCoreContext } from '../../common/modules/synth-core';
import { TransportContext } from '../../common/modules/transport';
import type { LoadNoiseSample, NoiseSample } from '../../services';
import { exportWav } from '../export';
import { TrackContext } from '../modules/track';
import { RollHeader } from './roll-header';
import { durationLabel, sizeLabel, wavFileName, wavTitle } from './export-wav-dialog';

jest.mock('../export', () => ({ exportWav: jest.fn() }));
const exportMock = exportWav as jest.MockedFunction<typeof exportWav>;

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve)));
const SAW = Array.from({ length: 2048 }, (_, i) => i / 1024 - 1);

afterEach(() => {
  cleanup();
  stopModels();
  jest.restoreAllMocks();
  jest.useRealTimers();
  exportMock.mockReset();
  sessionStorage.clear();
  // (the tempo of the field is kept there)
  localStorage.clear();
});

const editor = { shortcutsOpen: false, setShortcutsOpen: () => undefined } as unknown as React.ComponentProps<
  typeof RollHeader
>['editor'];

// the header of the roll in the synth (the models of the sound there), its clip of `notes`, the preset playing
// named `preset` (none: no presets), changed since it was opened while `$dirty`; the samples of its noise loaded by
// `loadNoiseSample` (none by default)
const setup = async ({
  notes = [[0, CLIP_PPQ, 60, 100]] as [number, number, number, number][],
  compact = false,
  preset = null as string | null,
  loadNoiseSample = undefined as LoadNoiseSample | undefined,
} = {}) => {
  // (the table of OSC 1 loaded)
  const modules = createSynth(
    ['default'],
    () => Promise.resolve({ frames: [SAW], morph: false }),
    loadNoiseSample
  );
  await flush();
  const { track } = createTrack(modules);
  if (notes.length) track[1].setNotes(notes);
  const stop = jest.spyOn(track[1], 'stop');
  const $dirty = new BehaviorSubject(false);
  const presets = preset
    ? ([
        { $current: new BehaviorSubject({ id: 'p1', name: preset }), $dirty },
        {},
      ] as unknown as React.ContextType<typeof PresetsContext>)
    : null;
  render(
    <PresetsContext.Provider value={presets}>
      <SynthCoreContext.Provider value={modules.synthCore}>
        <InputControllerContext.Provider value={modules.inputController}>
          <TransportContext.Provider value={modules.transport}>
            <Oscillator1Context.Provider value={modules.osc1}>
              <Oscillator2Context.Provider value={modules.osc2}>
                <NoiseContext.Provider value={modules.noise}>
                  <TrackContext.Provider value={track}>
                    <RollHeader editor={editor} onSave={() => undefined} saving={false} compact={compact} />
                  </TrackContext.Provider>
                </NoiseContext.Provider>
              </Oscillator2Context.Provider>
            </Oscillator1Context.Provider>
          </TransportContext.Provider>
        </InputControllerContext.Provider>
      </SynthCoreContext.Provider>
    </PresetsContext.Provider>
  );
  return { modules, track, stop, $dirty };
};

const key = () => screen.getByRole('button', { name: 'Export WAV' }) as HTMLButtonElement;
// the key of the dialog (the header has an Export of a .mid)
const exportKey = () =>
  within(screen.getByRole('dialog')).getByRole('button', { name: /^Export$|Rendering/ }) as HTMLButtonElement;
// the value chosen of each group: Format, Sample rate, Length, Level
const chosen = () =>
  ['Format', 'Sample rate', 'Length', 'Level'].map((group) =>
    screen
      .getByRole('radiogroup', { name: group })
      .querySelector("[aria-checked='true']")
      ?.getAttribute('data-value')
  );
const choose = (group: string, option: string) =>
  fireEvent.click(
    screen.getByRole('radiogroup', { name: group }).querySelector(`[data-value='${option}']`) as HTMLElement
  );

// the renders the spec settles: the options of each, then each resolved or rejected (by their order, the first by
// default)
const pending = () => {
  const settles: { resolve: (blob: Blob) => void; reject: (error: Error) => void }[] = [];
  exportMock.mockImplementation(
    () =>
      new Promise<Blob>((resolve, reject) => {
        settles.push({ resolve, reject });
      })
  );
  return {
    options: (index = 0) => exportMock.mock.calls[index][2],
    resolve: (blob: Blob, index = 0) => settles[index]?.resolve(blob),
    reject: (error: Error, index = 0) => settles[index]?.reject(error),
  };
};

const withDownload = () => {
  const createObjectURL = jest.fn(() => 'blob:x');
  Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return { createObjectURL, name: () => (click.mock.instances[0] as unknown as HTMLAnchorElement)?.download };
};

describe('Export WAV', () => {
  it('a first export: 16-bit, 44.1 kHz, the clip alone (its loop point in silence), as played; each told', async () => {
    await setup();
    pending();
    fireEvent.click(key());
    expect(chosen()).toEqual(['pcm16', '44100', 'clip', 'played']);
    expect(screen.getByText('Clip length, its end faded out: loops anywhere.')).toBeTruthy();
    choose('Length', 'tail');
    expect(screen.getByText('The clip once, then what sounds after it.')).toBeTruthy();
    choose('Length', 'loop');
    expect(screen.getByText('Clip length, its tail sounding into its start.')).toBeTruthy();
    choose('Length', 'clip');
    expect(screen.getByText('Through the limiter, as loud as it plays.')).toBeTruthy();
    choose('Level', 'headroom');
    expect(screen.getByText('No limiter: turned down as a whole if too loud.')).toBeTruthy();
    choose('Level', 'played');
    fireEvent.click(exportKey());
    await flush();
    expect(exportMock.mock.calls[0][2]).toMatchObject({
      format: 'pcm16',
      sampleRate: 44100,
      span: 'clip',
      level: 'played',
    });
  });

  it('names the file by the preset, the clip and the tempo as they are now; saves it so', async () => {
    const { modules, track } = await setup({ preset: 'Pad' });
    act(() => track[1].setName('Riff'));
    const download = withDownload();
    const render = pending();
    fireEvent.click(key());
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Pad - Riff 120 BPM.wav')).toBeTruthy();
    // a clip named as the preset: the name once
    act(() => track[1].setName('Pad'));
    expect(dialog.getByText('Pad 120 BPM.wav')).toBeTruthy();
    act(() => track[1].setName('Riff'));
    act(() => modules.transport[1].setBpm(97.5));
    expect(dialog.getByText('Pad - Riff 97.5 BPM.wav')).toBeTruthy();
    fireEvent.click(exportKey());
    await flush();
    render.resolve(new Blob(['RIFF']));
    await flush();
    expect(download.name()).toBe('Pad - Riff 97.5 BPM.wav');
  });

  it('under a MIDI Clock: at the tempo the piano roll shows (its own to 0.1), not the field', async () => {
    const { modules, track } = await setup({ preset: 'Pad' });
    act(() => track[1].setName('Riff'));
    const download = withDownload();
    const render = pending();
    fireEvent.click(key());
    const dialog = within(screen.getByRole('dialog'));
    const fact = (name: string) => dialog.getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
    const [, { setSource, follow }] = modules.transport;
    act(() => {
      setSource('midi');
      follow({ time: 0, beat: 0, bpm: 128.04 });
    });
    // 4 bars at 128 BPM
    expect(dialog.getByText('Pad - Riff 128 BPM.wav')).toBeTruthy();
    expect(fact('Duration')).toBe('7.50 s');
    // the clock gone: the field
    act(() => setSource('internal'));
    expect(dialog.getByText('Pad - Riff 120 BPM.wav')).toBeTruthy();
    expect(fact('Duration')).toBe('8.00 s');
    act(() => {
      setSource('midi');
      follow({ time: 0, beat: 0, bpm: 99.96 });
    });
    expect(dialog.getByText('Pad - Riff 100 BPM.wav')).toBeTruthy();
    fireEvent.click(exportKey());
    await flush();
    expect(exportMock.mock.calls[0][0].bpm).toBe(100);
    render.resolve(new Blob(['RIFF']));
    await flush();
    expect(download.name()).toBe('Pad - Riff 100 BPM.wav');
  });

  it('tags the file: its title, the preset and its link while the sound is that preset as saved', async () => {
    const { track, $dirty } = await setup({ preset: 'Pad' });
    act(() => track[1].setName('Riff'));
    withDownload();
    const render = pending();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    expect(render.options().tags).toEqual({
      title: 'Pad - Riff',
      preset: { name: 'Pad', url: 'http://localhost/?preset=p1' },
      synthUrl: 'http://localhost/',
      date: expect.any(Date),
    });
    render.resolve(new Blob(['RIFF']));
    await flush();
    // changed since it was opened: the sound is no longer the preset's, no link to it
    $dirty.next(true);
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    expect(exportMock.mock.calls[1][2].tags).toMatchObject({ title: 'Pad - Riff', preset: null });
  });

  it('tags a file of no preset as Chisper (a clip without a name), the link of the synth', async () => {
    await setup();
    const render = pending();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    expect(render.options().tags).toMatchObject({
      title: 'Chisper',
      preset: null,
      synthUrl: 'http://localhost/',
    });
  });

  it('tells the length of the clip, the duration and the size of the file as chosen', async () => {
    const { modules, track } = await setup();
    pending();
    fireEvent.click(key());
    const fact = (name: string) =>
      within(screen.getByRole('dialog')).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
    const facts = () => [fact('Clip'), fact('Duration'), fact('Size')];
    // 4 bars at 120 BPM: 8 s, 352800 frames of 4 bytes
    expect(facts()).toEqual(['4 bars', '8.00 s', '1.4 MB']);
    choose('Format', 'float32');
    expect(fact('Size')).toBe('2.8 MB');
    choose('Format', 'pcm24');
    choose('Sample rate', '48000');
    expect(fact('Size')).toBe('2.3 MB');
    choose('Format', 'pcm16');
    choose('Sample rate', '48000');
    expect(fact('Size')).toBe('1.5 MB');
    // a tail: known once rendered
    choose('Length', 'tail');
    expect(facts()).toEqual(['4 bars', '8.00 s + tail', '1.5 MB + tail']);
    choose('Length', 'loop');
    expect(facts()).toEqual(['4 bars', '8.00 s', '1.5 MB']);
    act(() => modules.transport[1].setBpm(97.5));
    act(() => track[1].setLength(2 * CLIP_BAR + CLIP_PPQ));
    expect(facts()).toEqual(['2 bars 1 beat', '5.54 s', '1.1 MB']);
    choose('Sample rate', '44100');
    choose('Length', 'clip');
    // a beat: 88 KB of samples, 6 KB of tags (the knob of its cover mostly)
    act(() => modules.transport[1].setBpm(120));
    act(() => track[1].setLength(CLIP_PPQ));
    expect(facts()).toEqual(['1 beat', '0.50 s', '94 KB']);
  });

  it('its keys named in words (a number over its unit, an icon by its label)', async () => {
    await setup();
    pending();
    fireEvent.click(key());
    const names = (group: string) =>
      within(screen.getByRole('radiogroup', { name: group }))
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('aria-label') ?? radio.textContent);
    expect(names('Format')).toEqual(['16-bit', '24-bit', '32-bit float']);
    expect(names('Sample rate')).toEqual(['44.1 kHz', '48 kHz']);
    expect(names('Length')).toEqual(['Clip', 'Clip + tail', 'Seamless loop']);
    expect(names('Level')).toEqual(['As played', 'Headroom']);
    expect(
      screen.getByRole('radio', { name: 'Seamless loop' }).querySelector('svg[aria-hidden]')
    ).toBeTruthy();
  });

  it('nothing in it takes focus (the QWERTY plays notes over it): its keys out of the tab order', async () => {
    await setup();
    pending();
    fireEvent.click(key());
    const dialog = screen.getByRole('dialog');
    const keys = [...within(dialog).getAllByRole('button'), ...within(dialog).getAllByRole('radio')];
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent || button.ariaLabel)
    ).toEqual(['Close', 'Cancel', 'Export']);
    expect(keys.map((key) => key.tabIndex).every((index) => index === -1)).toBe(true);
    expect(keys).not.toContain(document.activeElement);
    // Tab goes nowhere (out of the dialog: the page behind)
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
    expect(fireEvent.keyDown(document.body, { key: 'a' })).toBe(true);
  });

  it('its Close stops the render as Cancel does', async () => {
    await setup();
    const render = pending();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(render.options().signal?.aborted).toBe(true);
    // the page has its Tab again
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(true);
  });

  it('a key of the header, off while the clip has no notes', async () => {
    const { track } = await setup({ notes: [] });
    expect(key().disabled).toBe(true);
    act(() => track[1].setNotes([[0, CLIP_PPQ, 60, 100]]));
    expect(key().disabled).toBe(false);
    expect(key().textContent).toBe('.wav');
    expect(key().querySelector('svg')).toBeTruthy();
  });

  it('beside the .mid in the section of the files of the header', async () => {
    await setup();
    const files = screen.getByRole('group', { name: 'Download' });
    expect(
      within(files)
        .getAllByRole('button')
        .map((one) => one.getAttribute('aria-label'))
    ).toEqual(['Export MIDI', 'Export WAV']);
  });

  it('a key of its own on a phone: the icon alone, the only one of its section', async () => {
    await setup({ compact: true });
    expect(key().textContent).toBe('');
    expect(key().className).toContain('square');
    expect(within(screen.getByRole('group', { name: 'Download' })).getAllByRole('button')).toEqual([key()]);
  });

  it('off where the synth does not play', async () => {
    const { modules } = await setup();
    act(() => modules.synthCore[0].wavetables.$status.next('unsupported'));
    expect(key().disabled).toBe(true);
  });

  it('renders the clip with the options chosen, the sound of the page; saves the file and closes', async () => {
    const { modules, track, stop } = await setup();
    act(() => track[1].setName('Riff'));
    act(() => modules.synthCore[1].setMasterGain(0.5));
    const download = withDownload();
    const render = pending();
    const { named, features } = recordAnalytics();
    fireEvent.click(key());
    expect(screen.getByRole('dialog')).toBeTruthy();
    choose('Format', 'pcm16');
    choose('Sample rate', '44100');
    choose('Length', 'loop');
    choose('Level', 'headroom');
    fireEvent.click(exportKey());
    await flush();
    expect(stop).toHaveBeenCalled();
    const [sound, clip, options] = exportMock.mock.calls[0];
    expect(sound.snapshot).toEqual(getSnapshot());
    expect(sound.bpm).toBe(modules.transport[0].$bpm.value);
    // (its Master: over 0 dB it drives the limiter)
    expect(sound.masterGain).toBe(0.5);
    expect(sound.oscillators[0].frames).toEqual(
      modules.osc1[0].$waveTable.value.map(($frame) => $frame.value)
    );
    expect(clip).toEqual({ notes: [[0, CLIP_PPQ, 60, 100]], length: track[0].$clip.value.length });
    expect(options).toMatchObject({ format: 'pcm16', sampleRate: 44100, span: 'loop', level: 'headroom' });
    // its progress while it renders, the key of the export off
    act(() => render.options().onProgress?.(0.5));
    expect(screen.getByRole('progressbar', { name: 'Rendering' }).getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('50%')).toBeTruthy();
    expect(exportKey().disabled).toBe(true);
    // (nothing reported while it renders: the file is what counts)
    expect(named('wav_export')).toEqual([]);
    render.resolve(new Blob(['RIFF']));
    await flush();
    expect(download.createObjectURL).toHaveBeenCalled();
    expect(download.name()).toBe('Riff 120 BPM.wav');
    // the file saved, reported once: its options, its length (no preset: the sound is Init)
    const seconds = Math.round(
      (track[0].$clip.value.length / CLIP_PPQ) * (60 / modules.transport[0].$bpm.value)
    );
    expect(named('wav_export')).toEqual([
      { format: 'pcm16', sampleRate: 44100, span: 'loop', level: 'headroom', seconds, preset: null },
    ]);
    expect(features()).toEqual(['export:wav']);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('50%')).toBeNull();
  });

  it('renders the sound of the click, as named and tagged: not one applied while the chunk of the render loads', async () => {
    const { modules } = await setup();
    pending();
    fireEvent.click(key());
    const before = getSnapshot();
    const frames = modules.osc1[0].$waveTable.value.map(($frame) => $frame.value);
    fireEvent.click(exportKey());
    // (a preset applied before the chunk has loaded: its knobs, its table)
    act(() => {
      modules.noise[1].setNoiseValue('level', 0.6);
      modules.osc1[1].setWaveTable([SAW.map((x) => -x)]);
    });
    expect(getSnapshot()).not.toEqual(before);
    await flush();
    const [sound] = exportMock.mock.calls[0];
    expect(sound.snapshot).toEqual(before);
    expect(sound.oscillators[0].frames).toEqual(frames);
  });

  it('keeps the choices in the browser: a page loaded again opens them', async () => {
    await setup();
    pending();
    fireEvent.click(key());
    choose('Format', 'float32');
    choose('Length', 'loop');
    expect(JSON.parse(localStorage.getItem('exportWav') ?? 'null')).toEqual({
      format: 'float32',
      sampleRate: 44100,
      span: 'loop',
      level: 'played',
    });
    cleanup();
    stopModels();
    await setup();
    fireEvent.click(key());
    expect(chosen()).toEqual(['float32', '44100', 'loop', 'played']);
  });

  it('a choice stored that is none of its keys is its default, the others as stored; nothing that reads: the defaults', async () => {
    localStorage.setItem(
      'exportWav',
      JSON.stringify({ format: 'pcm8', sampleRate: 48000, span: 'loop', level: 7 })
    );
    await setup();
    fireEvent.click(key());
    expect(chosen()).toEqual(['pcm16', '48000', 'loop', 'played']);
    cleanup();
    stopModels();
    localStorage.setItem('exportWav', '{oops');
    await setup();
    fireEvent.click(key());
    expect(chosen()).toEqual(['pcm16', '44100', 'clip', 'played']);
  });

  it('reads the choices again at each opening (another key of the export, another tab)', async () => {
    await setup();
    fireEvent.click(key());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    localStorage.setItem('exportWav', JSON.stringify({ format: 'pcm24', sampleRate: 48000 }));
    fireEvent.click(key());
    expect(chosen()).toEqual(['pcm24', '48000', 'clip', 'played']);
  });

  it('Cancel stops the render: no file, no error', async () => {
    await setup();
    const download = withDownload();
    const error = jest.spyOn(toast, 'error');
    const render = pending();
    const { events, errors } = recordAnalytics();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    const { signal } = render.options();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(signal?.aborted).toBe(true);
    render.reject(new Error('aborted'));
    await flush();
    expect(download.createObjectURL).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    // (nothing reported: no file, no failure)
    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('Cancel frees the dialog at once: opened again it exports anew, the render cancelled tells nothing of its end', async () => {
    await setup();
    const download = withDownload();
    const error = jest.spyOn(toast, 'error');
    const render = pending();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    act(() => render.options(0).onProgress?.(0.5));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(render.options(0).signal?.aborted).toBe(true);
    // (the render cancelled still ending: the core it waits for) opened again, free
    fireEvent.click(key());
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(exportKey().disabled).toBe(false);
    fireEvent.click(exportKey());
    await flush();
    expect(exportMock).toHaveBeenCalledTimes(2);
    expect(render.options(1).signal?.aborted).toBe(false);
    act(() => render.options(1).onProgress?.(0.2));
    // the one cancelled tells its progress before it sees its cancel, then ends: the new one as it was
    act(() => render.options(0).onProgress?.(0.9));
    render.reject(new Error('aborted'), 0);
    await flush();
    expect(screen.getByRole('progressbar', { name: 'Rendering' }).getAttribute('aria-valuenow')).toBe('20');
    expect(exportKey().disabled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    render.resolve(new Blob(['RIFF']), 1);
    await flush();
    expect(download.createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('a render cancelled that still ends with its file: not saved', async () => {
    await setup();
    const download = withDownload();
    const render = pending();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    render.resolve(new Blob(['RIFF']));
    await flush();
    expect(download.createObjectURL).not.toHaveBeenCalled();
  });

  it('the dialog gone (the roll closed): its render stopped', async () => {
    await setup();
    const render = pending();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    cleanup();
    expect(render.options().signal?.aborted).toBe(true);
  });

  it('a render that fails: its error as a toast, no file', async () => {
    await setup();
    const download = withDownload();
    const error = jest.spyOn(toast, 'error').mockImplementation(() => '');
    const render = pending();
    const { named, errors } = recordAnalytics();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    const failure = new Error('Reverb failed in the render');
    render.reject(failure);
    await flush();
    expect(error).toHaveBeenCalledWith('Reverb failed in the render');
    // no file reported, the failure of the render once
    expect(named('wav_export')).toEqual([]);
    expect(errors).toEqual([
      {
        error: failure,
        properties: {
          source: 'engine',
          kind: 'render',
          $exception_fingerprint: 'engine:render:Reverb failed in the render',
        },
      },
    ]);
    expect(download.createObjectURL).not.toHaveBeenCalled();
    expect(exportKey().disabled).toBe(false);
  });

  it('the chunk of the render gone (a page of before a deploy): reload the page', async () => {
    await setup();
    const error = jest.spyOn(toast, 'error').mockImplementation(() => '');
    exportMock.mockRejectedValue(
      Object.assign(new Error('Loading chunk 552 failed. (missing: /552.e734db39.js)'), {
        name: 'ChunkLoadError',
      })
    );
    const { errors } = recordAnalytics();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    expect(error).toHaveBeenCalledWith(UPDATED);
    // (a page of before a deploy: no failure of ours)
    expect(errors).toEqual([]);
  });

  it('a sound still loading is not rendered', async () => {
    const { modules } = await setup();
    const error = jest.spyOn(toast, 'error').mockImplementation(() => '');
    act(() => modules.osc1[0].tableLoad.start());
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    expect(exportMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('The sound is still loading: export it once it has loaded');
  });

  it('a noise loading another sample is not rendered (the sample before held meanwhile is not taken for it)', async () => {
    // the loads of the samples, settled by the spec
    const loads: ((sample: NoiseSample) => void)[] = [];
    const { modules } = await setup({
      loadNoiseSample: () => new Promise<NoiseSample>((resolve) => loads.push(resolve)),
    });
    const [noise, noiseActions] = modules.noise;
    const error = jest.spyOn(toast, 'error').mockImplementation(() => '');
    const before: NoiseSample = { channels: [new Float32Array(64)], sampleRate: 44100 };
    const after: NoiseSample = { channels: [new Float32Array(64).fill(0.5)], sampleRate: 48000 };
    act(() => noiseActions.toggleActive());
    act(() => loads[0](before));
    await flush();
    expect(noise.$sample.value).toBe(before);
    act(() => noiseActions.setSamplePath(['Nature', 'Nature/Rain.wav']));
    expect(loads).toHaveLength(2);
    expect(noise.$sample.value).toBe(before);
    pending();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    expect(exportMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('The sound is still loading: export it once it has loaded');
    // loaded: the export plays it
    act(() => loads[1](after));
    await flush();
    fireEvent.click(exportKey());
    await flush();
    expect(exportMock.mock.calls[0][0].noise).toBe(after);
    expect(exportMock.mock.calls[0][0].snapshot).toMatchObject({
      noise: { p: ['Nature', 'Nature/Rain.wav'] },
    });
  });

  it('a noise whose sample failed to load (none before) is rendered without it, as the page plays it: not loading', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout'] });
    // (the failure told in the console)
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { modules } = await setup({ loadNoiseSample: () => Promise.reject(new Error('404')) });
    const [noise, noiseActions] = modules.noise;
    const error = jest.spyOn(toast, 'error').mockImplementation(() => '');
    act(() => noiseActions.toggleActive());
    // (tried thrice a second apart, then given up)
    for (let attempt = 0; attempt < 2; attempt++) {
      await flush();
      act(() => jest.advanceTimersByTime(1000));
    }
    await flush();
    expect(noise.$sampleLoading.value).toBe(false);
    expect(noise.$sample.value).toBeNull();
    pending();
    fireEvent.click(key());
    fireEvent.click(exportKey());
    await flush();
    expect(error).not.toHaveBeenCalled();
    expect(exportMock.mock.calls[0][0].noise).toBeNull();
    expect(exportMock.mock.calls[0][0].snapshot).toMatchObject({ noise: { a: true } });
  });

  it('its choices off while it renders (those of the file it makes); on again once it ends or is cancelled', async () => {
    await setup();
    withDownload();
    const render = pending();
    fireEvent.click(key());
    const radios = () => within(screen.getByRole('dialog')).getAllByRole('radio') as HTMLButtonElement[];
    const size = () =>
      within(screen.getByRole('dialog')).getByText('Size', { selector: 'dt' }).nextElementSibling
        ?.textContent;
    expect(radios().some((radio) => radio.disabled)).toBe(false);
    fireEvent.click(exportKey());
    await flush();
    expect(radios().every((radio) => radio.disabled)).toBe(true);
    const shown = size();
    choose('Format', 'float32');
    choose('Length', 'tail');
    expect(chosen()).toEqual(['pcm16', '44100', 'clip', 'played']);
    expect(size()).toBe(shown);
    expect(localStorage.getItem('exportWav')).toBeNull();
    render.resolve(new Blob(['RIFF']), 0);
    await flush();
    fireEvent.click(key());
    expect(radios().some((radio) => radio.disabled)).toBe(false);
    fireEvent.click(exportKey());
    await flush();
    expect(radios().every((radio) => radio.disabled)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(key());
    expect(radios().some((radio) => radio.disabled)).toBe(false);
  });
});

describe('wavTitle', () => {
  it('the preset and the clip, as the name of the file, its characters as they are; else Chisper', () => {
    expect(wavTitle({ name: 'Riff' }, 'Pad: soft')).toBe('Pad: soft - Riff');
    expect(wavTitle({ name: ' Pad ' }, 'Pad')).toBe('Pad');
    expect(wavTitle({ name: 'Riff/2' }, null)).toBe('Riff/2');
    expect(wavTitle({}, ' ')).toBe('Chisper');
  });
});

describe('wavFileName', () => {
  it('names the file by the preset and the clip (one where both have the one name, or one has none), the tempo', () => {
    expect(wavFileName({ name: 'Riff' }, 'Pad', 120)).toBe('Pad - Riff 120 BPM.wav');
    expect(wavFileName({ name: ' Pad ' }, 'Pad', 120)).toBe('Pad 120 BPM.wav');
    expect(wavFileName({ name: '  ' }, 'Pad: soft', 97.5)).toBe('Pad_ soft 97.5 BPM.wav');
    expect(wavFileName({ name: 'Riff' }, null, 120)).toBe('Riff 120 BPM.wav');
    expect(wavFileName({ name: 'Riff/2' }, ' ', 120)).toBe('Riff_2 120 BPM.wav');
    expect(wavFileName({}, null, 128.333)).toBe('Chisper 128.33 BPM.wav');
  });
});

describe('durationLabel, sizeLabel', () => {
  it('seconds under a minute, then minutes', () => {
    expect([9.846, 0.5, 59.994, 59.996, 62.5, 384].map(durationLabel)).toEqual([
      '9.85 s',
      '0.50 s',
      '59.99 s',
      '1:00.00',
      '1:02.50',
      '6:24.00',
    ]);
  });

  it('kilobytes under a megabyte, then megabytes (as the Finder counts them)', () => {
    expect([58, 640_044, 999_499, 999_500, 2_304_044, 147_456_058].map(sizeLabel)).toEqual([
      '1 KB',
      '640 KB',
      '999 KB',
      '1.0 MB',
      '2.3 MB',
      '147.5 MB',
    ]);
  });
});
