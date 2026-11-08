import { BehaviorSubject, combineLatest } from 'rxjs';
import { PrimitiveBS } from '@chisper/rxjs-react';
import { Clip, clipHash, ClipResponse, emptyClip, TEMPO_DEFAULT } from '@chisper/preset-schema';
import { appModel } from '../app/app/modules/app-module';
import { envelopes } from '../app/synth/common/modules/envelopes';
import { lfos } from '../app/synth/common/modules/lfos';
import { modulation } from '../app/synth/common/modules/modulation';
import { filter } from '../app/synth/filter/modules/filter';
import { fx } from '../app/synth/fx/modules/fx';
import type { SynthModule } from '../app/synth/common/modules/synth';
import type { LfoModule } from '../app/synth/common/modules/lfos';
import type { TransportModule } from '../app/synth/common/modules/transport';
import type { SoundSwitchModule } from '../app/synth/common/modules/sound-switch';
import type { FxNote } from '../app/synth/fx/effects/fx-modulation';
import { inputController } from '../app/synth/common/modules/input-controller';
import { noise } from '../app/synth/common/modules/noise';
import { oscillator } from '../app/synth/common/modules/oscillator';
import { synth } from '../app/synth/common/modules/synth';
import { synthCore } from '../app/synth/common/modules/synth-core';
import { transport } from '../app/synth/common/modules/transport';
import { dirtyOf, track } from '../app/synth/track/modules/track';
import type { TrackModule } from '../app/synth/track/modules/track';
import type { CreateTrackClock } from '../app/synth/track/track-clock';
import type { LoadNoiseSample, LoadWavetable } from '../app/synth/services';
import { initModel } from './model-registry';
import { MessageChannelStub } from './worker-stub';

export { initModel, stopModels } from './model-registry';

// the wavetable oscillator gets a stub channel (jsdom has no MessageChannel): it loads and gets ready
export const createSynthCore = () =>
  initModel(
    synthCore({ wavetables: { createChannel: () => new MessageChannelStub() as unknown as MessageChannel } }),
    'synthCore',
    undefined
  );

// the tempo and the transport on the clock of a synth core
export const createTransport = (synthCoreModule = createSynthCore()) =>
  initModel(transport({ synthCore: synthCoreModule }), 'transport', undefined);

export const createInputController = () => initModel(inputController(), 'inputController', undefined);

// the wavetable never loads by default: specs set tables themselves and there is no fetch in jsdom
export const createOscillator = (
  synthCoreModule = createSynthCore(),
  name = 'osc1',
  initial = { active: true, initialWavePath: ['default'] },
  loadWavetable: LoadWavetable = () => new Promise(() => undefined)
) => initModel(oscillator({ synthCore: synthCoreModule, loadWavetable }), name, initial);

// the noise: its sample never loads by default (no fetch in jsdom)
export const createNoise = (
  synthCoreModule = createSynthCore(),
  loadNoiseSample: LoadNoiseSample = () => new Promise(() => undefined)
) => initModel(noise({ synthCore: synthCoreModule, loadNoiseSample }), 'noise', undefined);

export const createEnvelopes = (transportModule = createTransport()) =>
  initModel(envelopes({ transport: transportModule }), 'env', undefined);

export const createModulation = () => initModel(modulation(), 'mod', undefined);

export const createLfos = (
  synthCoreModule = createSynthCore(),
  transportModule = createTransport(synthCoreModule)
) => initModel(lfos({ synthCore: synthCoreModule, transport: transportModule }), 'lfo', undefined);

// the whole voice chain: synth core, the transport, input, envelopes, the LFOs, modulation, both oscillators, the
// noise and the filter (the loaders of their tables and its sample: never by default)
export const createSynth = (
  initialWavePath = ['default'],
  loadWavetable?: LoadWavetable,
  loadNoiseSample?: LoadNoiseSample
) => {
  const synthCoreModule = createSynthCore();
  const transportModule = createTransport(synthCoreModule);
  const inputControllerModule = createInputController();
  const envelopesModule = createEnvelopes(transportModule);
  const lfosModule = createLfos(synthCoreModule, transportModule);
  const modulationModule = createModulation();
  const osc1 = createOscillator(synthCoreModule, 'osc1', { active: true, initialWavePath }, loadWavetable);
  const osc2 = createOscillator(synthCoreModule, 'osc2', { active: false, initialWavePath }, loadWavetable);
  const noiseModule = createNoise(synthCoreModule, loadNoiseSample);
  const filterModule = initModel(filter({ synthCore: synthCoreModule }), 'filter', undefined);
  const synthModule = initModel(
    synth({
      synthCore: synthCoreModule,
      transport: transportModule,
      inputController: inputControllerModule,
      envelopes: envelopesModule,
      lfo: lfosModule,
      modulation: modulationModule,
      oscillator: [osc1, osc2],
      noise: noiseModule,
      filter: filterModule,
    }),
    'synth',
    undefined
  );
  return {
    synthCore: synthCoreModule,
    transport: transportModule,
    inputController: inputControllerModule,
    envelopes: envelopesModule,
    lfos: lfosModule,
    modulation: modulationModule,
    filter: filterModule,
    osc1,
    osc2,
    noise: noiseModule,
    synth: synthModule,
  };
};

// a clock of the track the spec ticks: tick() runs a tick of the player while it was started
export const createTestClock = () => {
  const clock = {
    running: false,
    onTick: () => undefined as void,
    tick: () => clock.running && clock.onTick(),
  };
  const create: CreateTrackClock = (onTick) => {
    clock.onTick = onTick;
    return {
      start: () => (clock.running = true),
      stop: () => (clock.running = false),
      destroy: () => (clock.running = false),
    };
  };
  return { clock, create };
};

// the track on the synth of `createSynth`, its clock ticked by the spec
export const createTrack = (
  modules: ReturnType<typeof createSynth>,
  loadClip: (id: string) => Promise<ClipResponse> = () => Promise.reject(new Error('no clip'))
) => {
  const { clock, create } = createTestClock();
  const module = initModel(
    track({
      app: initModel(appModel(), 'appModel', undefined),
      synthCore: modules.synthCore,
      transport: modules.transport,
      inputController: modules.inputController,
      synth: modules.synth,
      createClock: create,
      loadClip,
    }),
    'track',
    undefined
  );
  return { track: module, clock };
};

// a sound switch that applies a preset at once: the presets without the synth
export const immediateSoundSwitch = () =>
  [{}, { switchSound: (apply: () => void) => apply() }] as unknown as SoundSwitchModule;

// a track for the presets without the synth: an empty clip not saved (a spec puts its clip in); a save of it takes
// its id and hash and it tells a change as the track does, the clips of presets it is given are recorded
export const fakeTrack = () => {
  const $clip = new BehaviorSubject<Clip>(emptyClip(TEMPO_DEFAULT));
  const $id = new PrimitiveBS<string | null>(null);
  const $savedHash = new PrimitiveBS<string | null>(null);
  const $dirty = new PrimitiveBS<boolean>(false);
  combineLatest([$clip, $savedHash]).subscribe(([clip, hash]) => $dirty.next(dirtyOf(clip, hash)));
  const setSaved = jest.fn((id: string, clip: Clip) => {
    $id.next(id);
    $savedHash.next(clipHash(clip));
  });
  return [
    { $clip, $id, $savedHash, $dirty },
    { setSaved, openPresetClip: jest.fn() },
  ] as unknown as TrackModule;
};

// an input controller with onPress/onRelease spied, for the controllers that feed it
export const createSpiedInputController = () => {
  const module = createInputController();
  const [, actions] = module;
  const onPress = jest.spyOn(actions as Pick<typeof actions, 'onPress'>, 'onPress');
  const onRelease = jest.spyOn(actions as Pick<typeof actions, 'onRelease'>, 'onRelease');
  return { module, onPress, onRelease };
};

// the fx model with the routes of a modulation model, the LFOs and the last note of the synth: a subject the spec
// drives
export const createFx = (
  synthCoreModule = createSynthCore(),
  modulationModule = createModulation(),
  lfos?: LfoModule,
  transport?: TransportModule
) => {
  const transportModule = transport ?? createTransport(synthCoreModule);
  const lfosModule = lfos ?? createLfos(synthCoreModule, transportModule);
  const $fxNote = new BehaviorSubject<FxNote | null>(null);
  const synthModule = [{ $fxNote }, {}] as unknown as SynthModule;
  const fxModule = initModel(
    fx({
      synthCore: synthCoreModule,
      transport: transportModule,
      synth: synthModule,
      lfo: lfosModule,
      modulation: modulationModule,
    }),
    'fx',
    undefined
  );
  return {
    fx: fxModule,
    modulation: modulationModule,
    lfos: lfosModule,
    transport: transportModule,
    $fxNote,
  };
};
