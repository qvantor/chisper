import { CLIP_PPQ } from '@chisper/preset-schema';
import { applySnapshot, getSnapshot } from '../app';
import { recordAnalytics } from '../../test-utils/analytics';
import {
  createFx,
  createInputController,
  createSynth,
  createTrack,
  stopModels,
} from '../../test-utils/models';
import { navigation, setLatencyMode, switchToNormalLatency } from './common/latency/latency';

// feature_used (common/services/analytics.ts): what a user does, never a state a preset, an undo or a restore sets
const flush = () => new Promise((resolve) => setTimeout(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const setup = async () => {
  const modules = createSynth();
  const { fx } = createFx(modules.synthCore, modules.modulation, modules.lfos, modules.transport);
  await flush();
  const { track } = createTrack(modules);
  return { ...modules, fx, track };
};
type Models = Awaited<ReturnType<typeof setup>>;

// everything a user may turn on: OSC 2, a table, noise, sub, unison, a filter type, effects, ENV 2, an LFO, a
// route, the voicing
const turnEverythingOn = ({
  osc1,
  osc2,
  noise,
  sub,
  filter,
  fx,
  envelopes,
  lfos,
  modulation,
  synth,
}: Models) => {
  osc2[1].toggleActive();
  osc1[1].setWaveTablePath(['other']);
  osc1[1].setOscValue('unison', 4);
  noise[1].toggleActive();
  sub[1].toggleActive();
  filter[1].toggleActive();
  filter[1].setType('highpass');
  fx[1].setAdded('reverb', true);
  fx[1].setAdded('delay', true);
  fx[1].setOn('chorus', true);
  envelopes[1].setEnvelopeValue('env2', 'attack', 0.2);
  lfos[1].setLfoValue('lfo3', 'rate', 2);
  modulation[1].addRoute('lfo1', 'osc1.wave');
  synth[1].setMaxVoices(1);
  synth[1].setLegato(true);
  synth[1].setPortamento(0.1);
};

afterEach(() => stopModels());

describe('feature_used', () => {
  it('the first use of each feature of the user: its actions, of each value', async () => {
    const models = await setup();
    const { features } = recordAnalytics();
    turnEverythingOn(models);
    const { osc1, noise, filter, fx, envelopes, synth, transport, track } = models;
    // what is not a use: off, ENV 1 (every patch's), one voice of unison, legato off, no glide
    noise[1].toggleActive();
    fx[1].setAdded('eq', false);
    fx[1].setOn('distortion', false);
    envelopes[1].setEnvelopeValue('env1', 'attack', 0.2);
    osc1[1].setOscValue('unison', 1);
    osc1[1].setOscValue('detune', 0.3);
    synth[1].setMaxVoices(8);
    synth[1].setLegato(false);
    synth[1].setPortamento(0);
    // the track: play, REC, an edit
    track[1].play();
    track[1].stop();
    track[1].record();
    track[1].setNotes([[0, CLIP_PPQ, 60, 100]]);
    transport[1].setSource('midi');
    filter[1].setType('highpass');
    expect(features()).toEqual([
      'wavetable',
      'unison',
      'noise',
      'sub',
      'filter:lowpass',
      'filter:highpass',
      'fx:reverb',
      'fx:delay',
      'fx:chorus',
      'env:env2',
      'lfo:lfo3',
      'route:lfo1',
      'voicing:mono',
      'voicing:legato',
      'voicing:portamento',
      'track:play',
      'track:rec',
      'track:edit',
      'midi_clock',
    ]);
  });

  it('a route the modulation refuses (already there) is no use', async () => {
    const { modulation } = await setup();
    modulation[1].addRoute('env3', 'osc1.wave');
    const { features } = recordAnalytics();
    modulation[1].addRoute('env3', 'osc1.wave');
    expect(features()).toEqual([]);
  });

  it('a preset applied (a snapshot: the sound switch, a restore of the tab, ?preset=) is no use', async () => {
    const first = await setup();
    turnEverythingOn(first);
    const sound = getSnapshot();
    stopModels();
    const models = await setup();
    const { features } = recordAnalytics();
    applySnapshot(sound);
    await flush();
    expect(models.osc2[0].$active.value).toBe(true);
    expect(models.noise[0].$active.value).toBe(true);
    expect(models.fx[0].$effects.value.reverb.added).toBe(true);
    expect(models.filter[0].$filterType.value).toBe('highpass');
    expect(models.modulation[0].$routes.value).toHaveLength(1);
    expect(models.synth[0].$maxVoices.value).toBe(1);
    expect(features()).toEqual([]);
  });

  it('an undo, a redo of the track and its clip restored from the tab are no use', async () => {
    const first = await setup();
    first.track[1].setNotes([[0, CLIP_PPQ, 60, 100]]);
    first.track[1].setNotes([[0, CLIP_PPQ, 62, 100]]);
    const { features } = recordAnalytics();
    first.track[1].undo();
    first.track[1].redo();
    expect(features()).toEqual([]);
    // (kept in the tab: the next setup reloads it)
    await wait(250);
    stopModels();
    const { track } = await setup();
    await flush();
    expect(track[0].$clip.value.notes).toEqual([[0, CLIP_PPQ, 62, 100]]);
    expect(features()).toEqual([]);
  });

  it('a key of the piano on the screen: its own input', () => {
    const { features } = recordAnalytics();
    const [{ $onPress }, { onScreenPress }] = createInputController();
    const presses = jest.fn();
    $onPress.subscribe(presses);
    onScreenPress([4, 'C']);
    expect(presses).toHaveBeenCalledWith({ note: [4, 'C'], velocity: expect.any(Number), source: 'keys' });
    expect(features()).toEqual(['input:piano']);
  });

  it('a latency chosen, or Normal taken after dropouts', () => {
    const reload = jest.spyOn(navigation, 'reload').mockImplementation(() => undefined);
    const { features } = recordAnalytics();
    setLatencyMode('low');
    switchToNormalLatency();
    expect(features()).toEqual(['latency:low', 'latency:normal']);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
