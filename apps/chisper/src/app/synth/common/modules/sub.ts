import { BehaviorSubject, combineLatest, distinctUntilChanged, filter, map, Observable } from 'rxjs';
import { ObjectBS, PrimitiveBS, rxModel, rxModelReact } from '@chisper/rxjs-react';
import { SUB_COARSE_MAX, SUB_DEFAULTS, SUB_OCTAVE_MAX, SubShape } from '@chisper/preset-schema';
import { Vector2D } from '@chisper/math';
import { urlSnapshotPlugin } from '../../../app';
import { subShapeFrame, subTable } from '../wavetable/sub-shapes';
import type { VoiceSubKnobs, VoiceSubOptions } from '../wavetable/voice-options';
import type { TableState } from '../wavetable/wavetable-engine';
import { SynthCoreModule } from './synth-core';

interface Dependencies {
  synthCore: SynthCoreModule;
}

// the knobs of the sub: its shape, Octave and Coarse (semitones, not whole) over the note, Phase (the share of a
// cycle a note starts at) and Contiguous (a note starts at the phase of the one before), the pan (-1..1) and the
// level (0..1: its square the amplitude)
export type SubKnobs = {
  shape: SubShape;
  octave: number;
  coarse: number;
  phase: number;
  contiguous: boolean;
  pan: number;
  level: number;
};
export type SubNumeric = 'octave' | 'coarse' | 'phase' | 'pan' | 'level';

const KNOB_DEFAULTS: SubKnobs = {
  shape: SUB_DEFAULTS.sh,
  octave: SUB_DEFAULTS.o,
  coarse: SUB_DEFAULTS.c,
  phase: SUB_DEFAULTS.ph,
  contiguous: SUB_DEFAULTS.ct,
  pan: SUB_DEFAULTS.pn,
  level: SUB_DEFAULTS.g,
};

// what a playing note follows of the knobs (a `knobs` event of the sub): the level, the pan, the pitch in cents
export const subParams = ({ level, pan, octave, coarse }: SubKnobs): VoiceSubKnobs => ({
  level,
  pan,
  cents: 1200 * octave + 100 * coarse,
});

// the sub oscillator: one cycle of a shape in every voice with the oscillators (sub.rs of the core), through the
// filter and ENV 1. A shape is a table of the wavetable oscillator (sub-shapes.ts), sent the first time it is on
// (the sine of the store needs none), kept after, removed with the model; one refused or failed plays in no note
// until it is sent again (Retry, or the shape on again)
export const sub = ({ synthCore: [{ wavetables }] }: Dependencies) =>
  rxModel(() => {
    const ranges: Record<SubNumeric, Vector2D> = {
      octave: [-SUB_OCTAVE_MAX, SUB_OCTAVE_MAX],
      coarse: [-SUB_COARSE_MAX, SUB_COARSE_MAX],
      phase: [0, 1],
      pan: [-1, 1],
      level: [0, 1],
    };
    const $active = new PrimitiveBS<boolean>(SUB_DEFAULTS.a);
    const $sub = new ObjectBS<SubKnobs>(KNOB_DEFAULTS);
    const $params = new BehaviorSubject<VoiceSubKnobs>(subParams($sub.value));
    // the tables of the shapes sent to the wavetable oscillator
    const sent = new Set<string>();
    // where the table of its shape is in the wavetable oscillator (null: the sine, or not sent yet; refused or
    // failed: SubStatus shows why, Retry sends it again)
    const $shapeState: Observable<TableState | null> = combineLatest([
      $sub.pipe(map(({ shape }) => subTable(shape))),
      wavetables.$tables,
    ]).pipe(
      map(([table, tables]) => (table === null ? null : (tables[table] ?? null))),
      distinctUntilChanged()
    );
    // the table of its shape refused by the store or failed to build
    const shapeFailed = () => {
      const table = subTable($sub.value.shape);
      const state = table === null ? undefined : wavetables.$tables.value[table];
      return state === 'refused' || state === 'failed';
    };
    // whether new notes play its shape: the sine of the store, or its table answered (stored; refused or failed: no
    // waiting for it, the sub is silent then)
    const shapePlayed = () => {
      const table = subTable($sub.value.shape);
      return table === null || (sent.has(table) && wavetables.$tables.value[table] !== 'sending');
    };
    // the sub of a note (null while off, or while the table of its shape is refused or failed: a voice would look
    // for it in the store every block and play nothing)
    const voiceSub = (): VoiceSubOptions | null => {
      if (!$active.value || shapeFailed()) return null;
      const { shape, phase, contiguous } = $sub.value;
      return { table: subTable(shape), phase, contiguous, ...$params.value };
    };
    return { ranges, $active, $sub, $params, $shapeState, sent, shapePlayed, voiceSub };
  })
    .actions(({ $active, $sub }) => ({
      toggleActive: () => $active.next(!$active.value),
      setShape: (shape: SubShape) => $sub.next({ ...$sub.value, shape }),
      setSubValue: (key: SubNumeric, value: number) => $sub.next({ ...$sub.value, [key]: value }),
      setContiguous: (contiguous: boolean) => $sub.next({ ...$sub.value, contiguous }),
      // the table of its shape sent again (refused by the store or failed to build)
      retryShape: () => {
        const table = subTable($sub.value.shape);
        if (table !== null) wavetables.retryTable(table);
      },
    }))
    // what playing notes follow
    .subscriptions(({ $sub, $params }) =>
      $sub
        .pipe(
          map(subParams),
          distinctUntilChanged((a, b) => a.level === b.level && a.pan === b.pan && a.cents === b.cents)
        )
        .subscribe($params)
    )
    // the table of its shape the first time it is on (also from presets); one refused or failed is sent again when
    // the shape is chosen again, the sub switched on or a preset with it on applied
    .subscriptions(({ $active, $sub, sent }) =>
      combineLatest([
        $active,
        $sub.pipe(
          map(({ shape }) => shape),
          distinctUntilChanged()
        ),
      ])
        .pipe(
          filter(([active]) => active),
          map(([, shape]) => shape)
        )
        .subscribe((shape) => {
          const table = subTable(shape);
          if (table === null) return;
          if (sent.has(table)) {
            wavetables.retryTable(table);
            return;
          }
          sent.add(table);
          wavetables.setTable(table, [subShapeFrame(shape)]);
        })
    )
    .plugins(
      urlSnapshotPlugin({
        modelToSnap: ({ $active, $sub }) => ({
          a: $active.value,
          sh: $sub.value.shape,
          o: $sub.value.octave,
          c: $sub.value.coarse,
          ph: $sub.value.phase,
          ct: $sub.value.contiguous,
          pn: $sub.value.pan,
          g: $sub.value.level,
        }),
        // a missing key: its default
        applySnap: (snap, { $active, $sub }) => {
          const active = snap.a ?? SUB_DEFAULTS.a;
          // switched off before its shape, on after it: no table of another shape is sent
          if (!active) $active.next(false);
          $sub.next({
            shape: snap.sh ?? KNOB_DEFAULTS.shape,
            octave: snap.o ?? KNOB_DEFAULTS.octave,
            coarse: snap.c ?? KNOB_DEFAULTS.coarse,
            phase: snap.ph ?? KNOB_DEFAULTS.phase,
            contiguous: snap.ct ?? KNOB_DEFAULTS.contiguous,
            pan: snap.pn ?? KNOB_DEFAULTS.pan,
            level: snap.g ?? KNOB_DEFAULTS.level,
          });
          $active.next(active);
        },
      })
    )
    .destroy(({ sent }) => {
      sent.forEach((table) => wavetables.removeTable(table));
    });

export const { ModelProvider: SubProvider, useModel: useSub } = rxModelReact('sub', sub);

export type SubModule = ReturnType<typeof useSub>;
export type SubModel = SubModule[0];
