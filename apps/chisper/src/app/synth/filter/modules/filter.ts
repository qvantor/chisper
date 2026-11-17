import { combineLatest, distinctUntilChanged, filter as keep, map, Observable, shareReplay } from 'rxjs';
import { isEqual, mapValues } from 'lodash';
import { FilterRange, FilterRanges, FilterParams, valueScale } from '@chisper/ui-kit';
import { ObjectBS, PrimitiveBS, rxModel, rxModelReact } from '@chisper/rxjs-react';
import { number } from '@chisper/math';
import { FilterType, isFilterType, isWebFilterType } from '@chisper/preset-schema';
import { SynthCoreModule } from '../../common/modules/synth-core';
import type { VoiceFilterOptions } from '../../common/wavetable/voice-options';
import { urlSnapshotPlugin } from '../../../app';
import {
  defaultFilterRanges,
  filterDefaultsOf,
  rangesOf,
  resonanceTravelOf,
  variationDefaultOf,
  VariationKind,
  variationKindOf,
} from '../constants';

interface Dependencies {
  synthCore: SynthCoreModule;
}

export type FilterValues = Omit<FilterParams, 'type'>;

// the travel of a knob (its share of the range, as the knob spreads it): Res of a type of a BiquadFilterNode (dB or a
// Q) and of a model type (%) are other units, a change of type between the two keeps where the knob is
const travelOf = ({ min, max, mode = 'linear' }: FilterRange) =>
  valueScale(mode).domain([min, max]).range([0, 1]).clamp(true);

// of a snapshot: the type whose units Res is in (`rt`, one that uses it; else a Biquad LP) and what Var is (`vk`, else
// Comp), for a type that doesn't use them
const unitsOf = (rt: unknown): FilterType =>
  isFilterType(rt) && !resonanceTravelOf(rt).disabled ? rt : 'lowpass';
const kindOf = (vk: unknown): VariationKind => (vk === 'eq' ? 'eq' : 'comp');

// the filter of the voices: each note filters its oscillators (voice-filter.ts), before its volume, so its
// envelopes move its own filter; the synth sends them $voiceFilter
export const filter = ({ synthCore: [{ audioCtx }] }: Dependencies) =>
  rxModel(() => {
    const { sampleRate } = audioCtx;
    const $active = new PrimitiveBS<boolean>(false);
    const $ranges = new ObjectBS<FilterRanges>(defaultFilterRanges);
    const $filterType = new PrimitiveBS<FilterType>('lowpass');
    const $filter = new ObjectBS<FilterValues>(filterDefaultsOf('lowpass'));
    // what Var is of the last type that used it (Comp, the Gain of the band of an EQ type): a type between two that
    // use it keeps it
    const $variationKind = new PrimitiveBS<VariationKind>('comp');
    // the type whose units Res is in: the last one that used it (a shelf between two keeps it, and their units)
    const $resonanceType = new PrimitiveBS<FilterType>('lowpass');
    // a change of type or a snapshot: its knobs and its type go to the voices together (a resonance in % of a model
    // type is not one in dB of a type of a BiquadFilterNode)
    const $changingType = new PrimitiveBS<boolean>(false);
    // what the voices play: the knobs of the filter, null while it is off
    const voiceFilter = (): VoiceFilterOptions | null =>
      $active.value ? { type: $filterType.value, ...$filter.value } : null;
    const $voiceFilter: Observable<VoiceFilterOptions | null> = combineLatest([
      $active,
      $filterType,
      $filter,
      $changingType,
    ]).pipe(
      keep(([, , , changing]) => !changing),
      map(voiceFilter),
      distinctUntilChanged(isEqual),
      shareReplay({ bufferSize: 1, refCount: true })
    );
    return {
      $active,
      $filter,
      $filterType,
      $ranges,
      $variationKind,
      $resonanceType,
      $changingType,
      voiceFilter,
      $voiceFilter,
      sampleRate,
    };
  })
    .actions(({ $active, $filter, $filterType, $ranges, $variationKind, $resonanceType, $changingType }) => ({
      toggleActive: () => $active.next(!$active.value),

      // a type that uses Res, of the other kind than the last one that did (of a BiquadFilterNode, a model one): Res
      // where its knob was; Var of the other meaning (Comp, the Gain of the band of an EQ type): its default
      setType: (type: FilterType) => {
        let values = $filter.value;
        const to = resonanceTravelOf(type);
        if (!to.disabled) {
          const from = $resonanceType.value;
          if (isWebFilterType(from) !== isWebFilterType(type)) {
            const share = travelOf(resonanceTravelOf(from))(values.resonance);
            values = { ...values, resonance: travelOf(to).invert(share) };
          }
          $resonanceType.next(type);
        }
        const kind = variationKindOf(type);
        if (kind && kind !== $variationKind.value) {
          values = { ...values, variation: variationDefaultOf(type) };
          $variationKind.next(kind);
        }
        $changingType.next(true);
        try {
          $filter.next(values);
          $filterType.next(type);
        } finally {
          $changingType.next(false);
        }
      },
      setNumericValue: (key: keyof FilterValues, value: number) => {
        $filter.next({
          ...$filter.value,
          [key]: value,
        });
      },
      setFilterValues: (values: FilterValues) => $filter.next(values),

      setRanges: (ranges: FilterRanges) => $ranges.next(ranges),
    }))
    .subscriptions(({ $filter, $filterType, $ranges }, { setRanges, setFilterValues }) => [
      $filterType.pipe(map(rangesOf)).subscribe(setRanges),
      $ranges.pipe(map(() => $filter.value)).subscribe((filter) => {
        const ranges = $ranges.value;
        const clamp = (value: number, key: string) => {
          const { min, max } = ranges[key as keyof FilterValues];
          return number.thresholds(value, min, max);
        };
        setFilterValues(mapValues(filter, clamp));
      }),
    ])
    .plugins(
      urlSnapshotPlugin({
        // (of a type that doesn't use Res or Var: the units of the one that did, where they aren't those applySnap
        // takes without them; the other presets don't have them)
        modelToSnap: ({ $active, $filterType, $filter, $resonanceType, $variationKind }) => {
          const type = $filterType.value;
          const rt =
            resonanceTravelOf(type).disabled && $resonanceType.value !== 'lowpass'
              ? $resonanceType.value
              : null;
          const vk = !variationKindOf(type) && $variationKind.value === 'eq' ? 'eq' : null;
          return {
            a: $active.value,
            t: type,
            cut: $filter.value.cutoff,
            gain: $filter.value.gain,
            res: $filter.value.resonance,
            dr: $filter.value.drive,
            v: $filter.value.variation,
            ...(rt && { rt }),
            ...(vk && { vk }),
          };
        },
        applySnap: (
          snap,
          { $active, $filterType, $filter, $variationKind, $resonanceType, $changingType }
        ) => {
          // (the voices get it once, its knobs with its type; a throw on the way never leaves them cut off)
          $changingType.next(true);
          try {
            if (snap.a !== undefined) $active.next(snap.a);
            // (a url snapshot skips the schema: a type this client doesn't know keeps the one it has)
            const type = isFilterType(snap.t) ? snap.t : $filterType.value;
            const defaults = filterDefaultsOf(type);
            $filter.next({
              cutoff: snap.cut ?? defaults.cutoff,
              resonance: snap.res ?? defaults.resonance,
              gain: snap.gain ?? defaults.gain,
              drive: snap.dr ?? defaults.drive,
              variation: snap.v ?? defaults.variation,
            });
            // type goes after values, so the new values are clamped by the type ranges
            $filterType.next(type);
            $variationKind.next(variationKindOf(type) ?? kindOf(snap.vk));
            $resonanceType.next(resonanceTravelOf(type).disabled ? unitsOf(snap.rt) : type);
          } finally {
            $changingType.next(false);
          }
        },
      })
    );
export const {
  ModelProvider: FilterProvider,
  useModel: useFilter,
  Context: FilterContext,
} = rxModelReact('filter', filter);

export type FilterModule = ReturnType<typeof useFilter>;
