import type { Model, ModelFactory, SnapshotScope } from '@chisper/rxjs-react';
import { envelopes } from '../../common/modules/envelopes';
import { inputController } from '../../common/modules/input-controller';
import { lfos } from '../../common/modules/lfos';
import { modulation } from '../../common/modules/modulation';
import { noise } from '../../common/modules/noise';
import { oscillator } from '../../common/modules/oscillator';
import { sub } from '../../common/modules/sub';
import { synth } from '../../common/modules/synth';
import type { SoundCore } from '../../common/modules/synth-core';
import { transport } from '../../common/modules/transport';
import type { UnisonShape } from '../../common/wavetable/voice-options';
import { filter } from '../../filter/modules/filter';
import { fx } from '../../fx/modules/fx';
import type { NoiseSample, Wavetable } from '../../services';

// the table an oscillator plays (drawn or edited ones too) and the shape of its unison, which no snapshot keeps
export interface RenderOscillator extends Wavetable {
  unisonShape: UnisonShape;
}

// The sound of the page as a render plays it: the snapshot of its models (getSnapshot), the tempo of its field,
// what the snapshot names but doesn't hold (the tables of the oscillators, the sample of the noise; null: none
// loaded, the noise rendered off), the master gain (its Master: over 1 it drives the limiter)
export interface RenderSound {
  snapshot: ReturnType<SnapshotScope['getSnapshot']>;
  bpm: number;
  oscillators: [RenderOscillator, RenderOscillator];
  noise: NoiseSample | null;
  masterGain: number;
}

// (a load the render never makes: its tables are the page's)
const never = () => new Promise<never>(() => undefined);

// A copy of the models of the sound on the core of a render (render-core.ts), in the order of the providers of the
// synth, without React: each inited in `scope` (a snapshot of its own: the models of the page keep theirs, the url
// is not read), at the tempo given (not kept by the browser). The sound applied: the snapshot, then the tables of
// the page (of the oscillators that are on) and the shapes of the unison
export const createRenderModels = (core: SoundCore, sound: RenderSound, scope: SnapshotScope) => {
  const running: (() => void)[] = [];
  const init = <M extends Record<string | number, unknown>, A, I>(
    factory: ModelFactory<M, A, I>,
    name: string,
    initial: I
  ): Model<M, A> => {
    const [model, actions, { stop }] = factory.init(name, initial, scope);
    running.push(stop);
    return [model, actions];
  };
  const synthCore = [core] as const;
  const inputControllerModule = init(inputController(), 'inputController', undefined);
  const transportModule = init(transport({ synthCore, bpm: sound.bpm }), 'transport', undefined);
  const envelopesModule = init(envelopes({ transport: transportModule }), 'env', undefined);
  const lfoModule = init(lfos({ synthCore, transport: transportModule }), 'lfo', undefined);
  const modulationModule = init(modulation(), 'mod', undefined);
  const osc1 = init(oscillator({ synthCore, loadWavetable: never }), 'osc1', {
    active: true,
    initialWavePath: [],
  });
  const osc2 = init(oscillator({ synthCore, loadWavetable: never }), 'osc2', {
    active: false,
    initialWavePath: [],
  });
  const noiseModule = init(
    noise({ synthCore, loadNoiseSample: () => (sound.noise ? Promise.resolve(sound.noise) : never()) }),
    'noise',
    undefined
  );
  const subModule = init(sub({ synthCore }), 'sub', undefined);
  const filterModule = init(filter({ synthCore }), 'filter', undefined);
  const synthModule = init(
    synth({
      synthCore,
      inputController: inputControllerModule,
      transport: transportModule,
      envelopes: envelopesModule,
      lfo: lfoModule,
      modulation: modulationModule,
      oscillator: [osc1, osc2],
      noise: noiseModule,
      sub: subModule,
      filter: filterModule,
    }),
    'synth',
    undefined
  );
  const fxModule = init(
    fx({
      synthCore,
      transport: transportModule,
      synth: synthModule,
      lfo: lfoModule,
      modulation: modulationModule,
    }),
    'fx',
    undefined
  );

  // a noise without its sample (its load failed, none before) off: the page plays none (a voice is silent without
  // it), the render waits for no table of it
  scope.applySnapshot(
    sound.noise ? sound.snapshot : { ...sound.snapshot, noise: { ...sound.snapshot['noise'], a: false } }
  );
  [osc1, osc2].forEach(([model, actions], index) => {
    const { frames, morph, unisonShape } = sound.oscillators[index];
    // (one that is off keeps its placeholder: no voice plays it, its table would be built and stored for nothing)
    if (model.$active.value) actions.setWaveTable(frames, morph);
    actions.setUnisonShape(unisonShape);
  });

  return {
    inputController: inputControllerModule,
    transport: transportModule,
    envelopes: envelopesModule,
    lfo: lfoModule,
    modulation: modulationModule,
    osc1,
    osc2,
    noise: noiseModule,
    sub: subModule,
    filter: filterModule,
    synth: synthModule,
    fx: fxModule,
    // in the reverse order (the providers unmount so)
    stop: () =>
      running
        .splice(0)
        .reverse()
        .forEach((stop) => stop()),
  };
};
export type RenderModels = ReturnType<typeof createRenderModels>;
