import { merge, type BehaviorSubject, type Observable } from 'rxjs';
import { AMP_PRECISION, filterKnobLooks, TIME_PRECISION } from '@chisper/ui-kit';
import {
  ENVELOPE_TIME_DIVISIONS,
  ENVELOPE_TIME_MAX,
  ENVELOPE_TIME_STAGES,
  ENVELOPES,
  EnvelopeId,
  EnvelopeStage,
  FX_TYPES,
  FxType,
  LfoId,
  LfoKnob,
  LFOS,
  MacroId,
  MACROS,
  PITCH_BEND_MAX,
  PORTAMENTO_MAX,
  SUB_SHAPES,
  TIME_DIVISIONS,
  VOICES_MAX,
} from '@chisper/preset-schema';
import { filterModel } from '@chisper/math';
import { EQ_PASS, eqTypeOf } from '@chisper/math/eq';
import { featureUsed } from '../../../common/services/analytics';
import { FX_REGISTRY, isFxUsable, MIX_PARAMS } from '../../fx/effects';
import { EQ_BANDS } from '../../fx/effects/eq-params';
import { fxFilterTypeOf } from '../../fx/effects/fxfilter-params';
import { isOn } from '../../fx/effects/tempo-sync';
import type { FxModule } from '../../fx/modules/fx';
import { bandLimit, bandValue } from '../../fx/components/controls/compressor-screen';
import type { FilterModule } from '../../filter/modules/filter';
import { defaultFilterRanges, rangesOf } from '../../filter/constants';
import { FILTER_TYPE_NAMES, FILTER_TYPE_ORDER } from '../../filter/filter-types';
import { CUSTOM_SHAPE, LFO_MODE_OPTIONS, LFO_SHAPE_OPTIONS, shapeOptionOf } from '../../lfo/lfo-shapes';
import { WARP_MODE_LABELS } from '../../oscillator/components/warp-mode';
import { SUB_SHAPE_NAMES } from '../../sub';
import { sourceLabel } from '../../envelope/envelope-colors';
import { dbToGain, gainToDb, MASTER_DB, MASTER_PRECISION } from '../../synth/components/master-handle';
import { OSC_PRECISION, OscillatorModule } from '../modules/oscillator';
import { NOISE_PRECISION, NoiseModule, NoiseNumeric } from '../modules/noise';
import { SUB_PRECISION, SubModule, SubNumeric } from '../modules/sub';
import type { EnvelopesModule } from '../modules/envelopes';
import {
  DIVISION_KEYS,
  LFO_KNOB_DEFS,
  lfoDivision,
  LfoModule,
  lfoPeriodOf,
  LfoTimeKnob,
  rateKnobSteps,
} from '../modules/lfos';
import { MACRO_PRECISION, ModulationModule } from '../modules/modulation';
import type { SynthModule } from '../modules/synth';
import type { SynthCoreModule } from '../modules/synth-core';
import type { TransportModule } from '../modules/transport';
import type { KnobDef } from './cc-value';

// a control of the synth a CC moves (MIDI Learn), by its id: the id of the modulation target of a knob that takes
// routes (osc1.wave, filter.cutoff, delay.time…), else one of its own (osc1.oct, env1.attack, filter.type,
// delay.on…). Its name is the section and the label (a list of the bindings, a toast). It is set through the action
// a hand on it calls, where a mouse would put it: a knob a share of its travel in its scale (`def`: its range as the
// state has it now: the type of the filter, the frames of the table, a time in BPM as its divisions), a switch on or
// off, a choice one of its options
interface TargetBase {
  id: string;
  name: () => string;
  // the screen lets a hand move it now (none: always): a CC moves no control the screen shows disabled (Anchor out
  // of Free, TRIP and DOT out of BPM, Warp with its mode Off, a knob of the filter its type doesn't use, the controls
  // of an effect that is off or out of the rack, the Gain of an EQ band that is a pass, Res and Fat of the FX Filter
  // where its type reads none)
  enabled?: () => boolean;
}
export interface KnobTarget extends TargetBase {
  kind: 'knob';
  def: () => KnobDef;
  get: () => number;
  set: (value: number) => void;
  // what emits when it may have changed (Pickup: a change that is not of its CC takes it off the controller)
  changes: Observable<unknown>;
}
export interface SwitchTarget extends TargetBase {
  kind: 'switch';
  get: () => boolean;
  set: (on: boolean) => void;
}
export interface ChoiceTarget extends TargetBase {
  kind: 'choice';
  // its options (their labels in order)
  options: readonly string[];
  // the index of its option now (-1: none of them, a custom shape)
  get: () => number;
  set: (index: number) => void;
}
export type MidiTarget = KnobTarget | SwitchTarget | ChoiceTarget;

// what a target shows now: its value of a switch or a choice (a knob shows its own)
export const targetText = (target: SwitchTarget | ChoiceTarget) =>
  target.kind === 'switch' ? (target.get() ? 'On' : 'Off') : (target.options[target.get()] ?? '—');

export interface MidiTargetsDeps {
  synthCore: SynthCoreModule;
  transport: TransportModule;
  envelopes: EnvelopesModule;
  lfo: LfoModule;
  modulation: ModulationModule;
  oscillators: [OscillatorModule, OscillatorModule];
  noise: NoiseModule;
  sub: SubModule;
  filter: FilterModule;
  synth: SynthModule;
  fx: FxModule;
}

const named = (name: string) => () => name;
const ENVELOPE_LABELS: Record<EnvelopeStage, string> = {
  attack: 'Attack',
  hold: 'Hold',
  decay: 'Decay',
  sustain: 'Sustain',
  release: 'Release',
};
const LFO_KNOB_KEYS = Object.keys(LFO_KNOB_DEFS) as LfoKnob[];
const LFO_SHAPE_LABELS = LFO_SHAPE_OPTIONS.map(({ name }) => name);
const LFO_MODE_LABELS = LFO_MODE_OPTIONS.map(({ name }) => name);
const FILTER_TYPE_LABELS = FILTER_TYPE_ORDER.map((type) => FILTER_TYPE_NAMES[type]);
// the knobs of the filter by their ids (their labels by the type: filterKnobLooks)
const FILTER_KNOBS = {
  cutoff: 'filter.cutoff',
  resonance: 'filter.resonance',
  gain: 'filter.gain',
  drive: 'filter.drive',
  variation: 'filter.var',
} as const;
// the params of an effect shown as keys (on or off), the other params of options are choices
const FX_SWITCHES = new Set(['sync', 'trip', 'dot', 'hpf']);
// the keys of the note values of an effect: only in BPM
const NOTE_VALUE_KEYS = new Set(['trip', 'dot']);
// the params of an effect that are no control of their own: the division of its knob of a time in BPM is that knob
const FX_HIDDEN = new Set(['div']);

// a knob that is a subject of its model, set by its action (`changes`: its value, and what changes its range)
const subjectKnob = (
  id: string,
  name: string,
  $value: BehaviorSubject<number>,
  set: (value: number) => void,
  def: () => KnobDef,
  changes: Observable<unknown> = $value
): KnobTarget => ({
  id,
  kind: 'knob',
  name: named(name),
  def,
  get: () => $value.value,
  set,
  changes,
});

// the switch of a section (Osc 1, Sub, Noise, Filter): its model toggles it
const activeSwitch = (
  id: string,
  name: string,
  $active: BehaviorSubject<boolean>,
  toggle: () => void
): SwitchTarget => ({
  id,
  kind: 'switch',
  name: named(name),
  get: () => $active.value,
  set: (on) => {
    if (on !== $active.value) toggle();
  },
});

// the knobs of a record of a model (an oscillator, the sub, the noise) by their keys: their ranges and steps
const recordKnobs =
  <K extends string>(
    prefix: string,
    section: string,
    $record: Observable<unknown> & { readonly value: Record<K, number> },
    ranges: Record<K, readonly number[]>,
    precision: Record<K, number>,
    setValue: (key: K, value: number) => void
  ) =>
  (id: string, label: string, key: K, cyclic = false): KnobTarget => ({
    id: `${prefix}.${id}`,
    kind: 'knob',
    name: named(`${section} ${label}`),
    def: () => ({ min: ranges[key][0], max: ranges[key][1], precision: precision[key], cyclic }),
    get: () => $record.value[key],
    set: (value) => setValue(key, value),
    changes: $record,
  });

const oscillatorTargets = (osc: 1 | 2, [model, actions]: OscillatorModule): MidiTarget[] => {
  const { $active, $gain, $position, $frames, $warp, $warpMode, $osc, ranges } = model;
  const { toggleActive, setGain, setPosition, setWarp, setWarpMode, setOscValue } = actions;
  const prefix = `osc${osc}`;
  const section = `Osc ${osc}`;
  const knob = recordKnobs(prefix, section, $osc, ranges, OSC_PRECISION, setOscValue);
  return [
    activeSwitch(`${prefix}.on`, section, $active, () => {
      // (OSC 2 on: a use, as its switch counts it)
      if (osc === 2 && !$active.value) featureUsed('osc2');
      toggleActive();
    }),
    subjectKnob(`${prefix}.gain`, `${section} Gain`, $gain, setGain, () => ({
      min: 0,
      max: 1,
      precision: OSC_PRECISION.gain,
    })),
    subjectKnob(
      `${prefix}.wave`,
      `${section} Wave`,
      $position,
      setPosition,
      () => ({
        min: 0,
        max: Math.max(0, $frames.value - 1),
        precision: OSC_PRECISION.wave,
      }),
      merge($position, $frames)
    ),
    {
      ...subjectKnob(`${prefix}.warp`, `${section} Warp`, $warp, setWarp, () => ({
        min: 0,
        max: 1,
        precision: OSC_PRECISION.warp,
      })),
      enabled: () => $warpMode.value !== 0,
    },
    {
      id: `${prefix}.warpMode`,
      kind: 'choice',
      name: named(`${section} Warp mode`),
      options: WARP_MODE_LABELS,
      get: () => $warpMode.value,
      set: setWarpMode,
    },
    knob('detune', 'Detune', 'detune'),
    knob('blend', 'Blend', 'blend'),
    knob('oct', 'Oct', 'octave'),
    knob('pitch', 'Semi', 'semi'),
    knob('fine', 'Fine', 'fine'),
    knob('phase', 'Phase', 'phase', true),
    knob('phaseRand', 'Phase rand', 'phaseRand'),
    knob('unison', 'Unison', 'unison'),
  ];
};

const subTargets = ([{ $active, $sub, ranges }, actions]: SubModule): MidiTarget[] => {
  const knob = recordKnobs<SubNumeric>('sub', 'Sub', $sub, ranges, SUB_PRECISION, actions.setSubValue);
  return [
    activeSwitch('sub.on', 'Sub', $active, actions.toggleActive),
    {
      id: 'sub.shape',
      kind: 'choice',
      name: named('Sub Shape'),
      options: SUB_SHAPE_NAMES,
      get: () => SUB_SHAPES.indexOf($sub.value.shape),
      set: (index) => actions.setShape(SUB_SHAPES[index]),
    },
    {
      id: 'sub.contiguous',
      kind: 'switch',
      name: named('Sub Contiguous'),
      get: () => $sub.value.contiguous,
      set: actions.setContiguous,
    },
    knob('oct', 'Oct', 'octave'),
    knob('crs', 'Crs', 'coarse'),
    knob('phase', 'Phase', 'phase', true),
    knob('pan', 'Pan', 'pan'),
    knob('level', 'Gain', 'level'),
  ];
};

const noiseTargets = ([{ $active, $noise, ranges }, actions]: NoiseModule): MidiTarget[] => {
  const knob = recordKnobs<NoiseNumeric>(
    'noise',
    'Noise',
    $noise,
    ranges,
    NOISE_PRECISION,
    actions.setNoiseValue
  );
  return [
    activeSwitch('noise.on', 'Noise', $active, actions.toggleActive),
    {
      id: 'noise.loop',
      kind: 'switch',
      name: named('Noise Loop'),
      get: () => $noise.value.loop,
      set: actions.setLoop,
    },
    {
      id: 'noise.keytrack',
      kind: 'switch',
      name: named('Noise Pitch Track'),
      get: () => $noise.value.keytrack,
      set: actions.setKeytrack,
    },
    knob('start', 'Start', 'start'),
    knob('rand', 'Rand', 'rand'),
    knob('pitch', 'Pitch', 'pitch'),
    knob('fine', 'Fine', 'fine'),
    knob('pan', 'Pan', 'pan'),
    knob('level', 'Gain', 'level'),
  ];
};

const filterTargets = ([
  { $active, $filter, $filterType },
  { toggleActive, setType, setNumericValue },
]: FilterModule): MidiTarget[] => [
  activeSwitch('filter.on', 'Filter', $active, toggleActive),
  {
    id: 'filter.type',
    kind: 'choice',
    name: named('Filter Type'),
    options: FILTER_TYPE_LABELS,
    get: () => FILTER_TYPE_ORDER.indexOf($filterType.value),
    set: (index) => setType(FILTER_TYPE_ORDER[index]),
  },
  ...(Object.keys(FILTER_KNOBS) as (keyof typeof FILTER_KNOBS)[]).map((key): KnobTarget => ({
    id: FILTER_KNOBS[key],
    kind: 'knob',
    // its label as the type shows it (Res or Q, Comp or the Gain of an EQ type)
    name: () => `Filter ${filterKnobLooks($filterType.value)[key].label}`,
    // the range of the type (a knob it doesn't use: of its default range, the value kept for a type that does)
    def: () => {
      const range = rangesOf($filterType.value)[key];
      return range.disabled ? defaultFilterRanges[key] : range;
    },
    enabled: () => !rangesOf($filterType.value)[key].disabled,
    get: () => $filter.value[key],
    set: (value) => setNumericValue(key, value),
    // (its range is of the type)
    changes: merge($filter, $filterType),
  })),
];

const envelopeTargets = ([
  { $envelopes, $velocity },
  { setEnvelopeValue, setEnvelopeDivision, setEnvelopeBpm, setVelocity },
]: EnvelopesModule): MidiTarget[] => [
  ...ENVELOPES.flatMap((id: EnvelopeId, index): MidiTarget[] => {
    const section = `ENV ${index + 1}`;
    const time = (stage: (typeof ENVELOPE_TIME_STAGES)[number]): KnobTarget => ({
      id: `${id}.${stage}`,
      kind: 'knob',
      name: named(`${section} ${ENVELOPE_LABELS[stage]}`),
      // in BPM the knob steps through the divisions of the tempo
      def: () =>
        $envelopes.value[id].bpm
          ? { min: 0, max: 0, steps: ENVELOPE_TIME_DIVISIONS }
          : { min: 0, max: ENVELOPE_TIME_MAX, mode: 'pow', precision: TIME_PRECISION },
      get: () => ($envelopes.value[id].bpm ? $envelopes.value[id].divs[stage] : $envelopes.value[id][stage]),
      set: (value) =>
        $envelopes.value[id].bpm ? setEnvelopeDivision(id, stage, value) : setEnvelopeValue(id, stage, value),
      changes: $envelopes,
    });
    return [
      ...ENVELOPE_TIME_STAGES.map(time),
      {
        id: `${id}.sustain`,
        kind: 'knob',
        name: named(`${section} Sustain`),
        def: () => ({ min: 0, max: 1, precision: TIME_PRECISION }),
        get: () => $envelopes.value[id].sustain,
        set: (value) => setEnvelopeValue(id, 'sustain', value),
        changes: $envelopes,
      },
      {
        id: `${id}.bpm`,
        kind: 'switch',
        name: named(`${section} BPM`),
        get: () => $envelopes.value[id].bpm,
        set: (on) => setEnvelopeBpm(id, on),
      },
    ];
  }),
  {
    id: 'vel.amp',
    kind: 'knob',
    name: named('VELO Amp'),
    def: () => ({ min: 0, max: 1, precision: AMP_PRECISION }),
    get: () => $velocity.value.amp,
    set: (value) => setVelocity('amp', value),
    changes: $velocity,
  },
];

const lfoTargets = ([{ $lfos }, actions]: LfoModule, [{ $tempo }]: TransportModule): MidiTarget[] =>
  LFOS.flatMap((id: LfoId, index): MidiTarget[] => {
    const section = `LFO ${index + 1}`;
    const lfo = () => $lfos.value[id];
    // a knob of a time in BPM: its divisions (Rate right faster, its steps at the tempo)
    const divisions = (knob: LfoTimeKnob) =>
      knob === 'rate' ? rateKnobSteps(lfo(), $tempo.value) : TIME_DIVISIONS;
    // (a knob of a time in BPM: a division)
    const timed = (knob: LfoKnob): LfoTimeKnob | null =>
      lfo().bpm && knob in DIVISION_KEYS ? (knob as LfoTimeKnob) : null;
    const knob = (key: LfoKnob): KnobTarget => ({
      id: `${id}.${key}`,
      kind: 'knob',
      name: named(`${section} ${LFO_KNOB_DEFS[key].label}`),
      def: () => {
        const time = timed(key);
        return time ? { min: 0, max: 0, steps: divisions(time) } : LFO_KNOB_DEFS[key];
      },
      get: () => {
        const time = timed(key);
        if (time) return time === 'rate' ? lfoDivision(lfo(), $tempo.value) : lfo()[DIVISION_KEYS[time]];
        // Rate shows the frequency
        return key === 'rate' ? 1 / lfo().rate : lfo()[key];
      },
      set: (value) => {
        const time = timed(key);
        if (time) actions.setDivision(id, time, value);
        else actions.setLfoValue(id, key, key === 'rate' ? lfoPeriodOf(value) : value);
      },
      // (the steps of Rate in BPM are of the tempo)
      changes: merge($lfos, $tempo),
    });
    const flag = (
      key: 'bpm' | 'host' | 'trip' | 'dot',
      label: string,
      set: (on: boolean) => void,
      enabled?: () => boolean
    ): MidiTarget => ({
      id: `${id}.${key}`,
      kind: 'switch',
      name: named(`${section} ${label}`),
      enabled,
      get: () => lfo()[key],
      set,
    });
    return [
      ...LFO_KNOB_KEYS.map(knob),
      {
        id: `${id}.shape`,
        kind: 'choice',
        name: named(`${section} Shape`),
        options: LFO_SHAPE_LABELS,
        get: () => {
          const shape = shapeOptionOf(lfo());
          return shape === CUSTOM_SHAPE ? -1 : LFO_SHAPE_OPTIONS.findIndex((option) => option.id === shape);
        },
        set: (index) => {
          const option = LFO_SHAPE_OPTIONS[index];
          if ('points' in option) actions.setPoints(id, option.points);
          else actions.setShape(id, option.shape);
        },
      },
      {
        id: `${id}.mode`,
        kind: 'choice',
        name: named(`${section} Mode`),
        options: LFO_MODE_LABELS,
        get: () => LFO_MODE_OPTIONS.findIndex(({ value }) => value === lfo().mode),
        set: (index) => actions.setMode(id, LFO_MODE_OPTIONS[index].value),
      },
      flag('bpm', 'BPM', (on) => actions.setBpm(id, on)),
      flag(
        'host',
        'Anchor',
        (on) => actions.setHost(id, on),
        () => lfo().mode === 'free'
      ),
      flag(
        'trip',
        'Triplets',
        (on) => actions.setTrip(id, on),
        () => lfo().bpm
      ),
      flag(
        'dot',
        'Dotted',
        (on) => actions.setDot(id, on),
        () => lfo().bpm
      ),
    ];
  });

const macroTargets = ([{ $macros, $macroNames }, { setMacro }]: ModulationModule): MidiTarget[] =>
  MACROS.map((id: MacroId, index): KnobTarget => ({
    id,
    kind: 'knob',
    // its name as typed (MACRO 1 without one)
    name: () => sourceLabel(id, $macroNames.value),
    def: () => ({ min: 0, max: 1, precision: MACRO_PRECISION }),
    get: () => $macros.value[index],
    set: (level) => setMacro(id, level, undefined, 'midi'),
    changes: $macros,
  }));

const voicingTargets = (
  [
    { $maxVoices, $legato, $portamento, $bendUp, $bendDown },
    { setMaxVoices, setLegato, setPortamento, setBendUp, setBendDown },
  ]: SynthModule,
  [{ $masterGain }, { setMasterGain }]: SynthCoreModule
): MidiTarget[] => [
  subjectKnob('voicing.poly', 'Poly', $maxVoices, setMaxVoices, () => ({
    min: 1,
    max: VOICES_MAX,
    precision: 1,
  })),
  {
    id: 'voicing.legato',
    kind: 'switch',
    name: named('Legato'),
    get: () => $legato.value,
    set: setLegato,
  },
  subjectKnob('voicing.portamento', 'Portamento', $portamento, setPortamento, () => ({
    min: 0,
    max: PORTAMENTO_MAX,
    precision: 1,
  })),
  subjectKnob('bend.up', 'Bend Up', $bendUp, setBendUp, () => ({
    min: 0,
    max: PITCH_BEND_MAX,
    precision: 1,
  })),
  subjectKnob('bend.down', 'Bend Down', $bendDown, setBendDown, () => ({
    min: 0,
    max: PITCH_BEND_MAX,
    precision: 1,
  })),
  {
    id: 'master',
    kind: 'knob',
    name: named('Master'),
    // in dB, as its knob
    def: () => ({ min: MASTER_DB.min, max: MASTER_DB.max, precision: MASTER_PRECISION }),
    get: () => gainToDb($masterGain.value),
    set: (db) => setMasterGain(dbToGain(db)),
    changes: $masterGain,
  },
];

const fxTargets = ([{ $effects, $status }, { setOn, setMix, setParam }]: FxModule): MidiTarget[] =>
  FX_TYPES.flatMap((type: FxType): MidiTarget[] => {
    const { label: effect, params: defs, tempo } = FX_REGISTRY[type];
    const params = () => $effects.value[type].params;
    // its panel is in the rack (getChain), its controls are not greyed (on)
    const shown = () => $effects.value[type].added && isFxUsable($status.value[type]);
    const playing = () => shown() && $effects.value[type].on;
    const param = (key: string, def: (typeof defs)[string]): MidiTarget => {
      const id = `${type}.${key}`;
      if (def.options) {
        const labels = def.options.map(({ label }) => label);
        if (FX_SWITCHES.has(key))
          return {
            id,
            kind: 'switch',
            name: named(`${effect} ${def.name ?? def.label}`),
            // (TRIP and DOT only in BPM)
            enabled: NOTE_VALUE_KEYS.has(key) ? () => playing() && isOn(params()['sync']) : playing,
            get: () => isOn(params()[key]),
            set: (on) => setParam(type, key, +on),
          };
        return {
          id,
          kind: 'choice',
          name: named(`${effect} ${def.label}`),
          enabled: playing,
          options: labels,
          get: () => Math.round(params()[key]),
          set: (index) => setParam(type, key, index),
        };
      }
      // the knob of a time in BPM: its division; the crossovers of the compressor stop at each other
      const synced = () => tempo?.knob === key && isOn(params()['sync']);
      const crossover = type === 'compressor' && (key === 'xlow' || key === 'xhigh');
      // the Gain of an EQ band: none for a pass
      const band = type === 'eq' ? EQ_BANDS.find(({ gain }) => gain === key) : undefined;
      // Res and Fat of the FX Filter: none where its type reads none (a one-pole, a notch)
      const fxFilterKnob = type === 'fxfilter' && (key === 'res' || key === 'var');
      const used = () => {
        if (band) return eqTypeOf(params()[band.type]) !== EQ_PASS;
        if (!fxFilterKnob) return true;
        const uses = filterModel.modelKnobsOf(fxFilterTypeOf(params()['type']));
        return key === 'res' ? uses.resonance : uses.variation;
      };
      return {
        id,
        kind: 'knob',
        name: named(`${effect} ${def.label}`),
        enabled: band || fxFilterKnob ? () => playing() && used() : playing,
        def: () => (synced() && tempo ? { min: 0, max: 0, steps: tempo.stepsOf(params()) } : def),
        get: () => {
          if (synced() && tempo) return tempo.divisionOf(params());
          return crossover ? bandValue(key, params()) : params()[key];
        },
        set: (value) => {
          if (synced()) setParam(type, 'div', value);
          else if (crossover) setParam(type, key, bandLimit(params()['xlow'], params()['xhigh'])(key, value));
          else setParam(type, key, value);
        },
        changes: $effects,
      };
    };
    return [
      {
        id: `${type}.on`,
        kind: 'switch',
        name: named(effect),
        enabled: shown,
        get: () => $effects.value[type].on,
        set: (on) => setOn(type, on),
      },
      {
        id: `${type}.mix`,
        kind: 'knob',
        name: named(`${effect} Mix`),
        enabled: playing,
        def: () => MIX_PARAMS[type],
        get: () => $effects.value[type].mix,
        set: (mix) => setMix(type, mix),
        changes: $effects,
      },
      ...Object.entries(defs)
        .filter(([key]) => !FX_HIDDEN.has(key))
        .map(([key, def]) => param(key, def)),
    ];
  });

// every control of the synth a CC may move, by id
export const createMidiTargets = (deps: MidiTargetsDeps): ReadonlyMap<string, MidiTarget> =>
  new Map(
    [
      ...oscillatorTargets(1, deps.oscillators[0]),
      ...oscillatorTargets(2, deps.oscillators[1]),
      ...subTargets(deps.sub),
      ...noiseTargets(deps.noise),
      ...filterTargets(deps.filter),
      ...envelopeTargets(deps.envelopes),
      ...lfoTargets(deps.lfo, deps.transport),
      ...macroTargets(deps.modulation),
      ...voicingTargets(deps.synth, deps.synthCore),
      ...fxTargets(deps.fx),
    ].map((target) => [target.id, target])
  );
