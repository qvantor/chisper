import React from 'react';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { Filter, FilterNumerics, Section } from '@chisper/ui-kit';
import { FilterType, PRESET_DEFAULTS } from '@chisper/preset-schema';
import { useFilter } from '../modules';
import { variationDefaultOf } from '../constants';
import { useKnobModulation } from '../../modulation/use-knob-modulation';
import { filterTargetScale } from '../../common/modulation/modulation-targets';
import { FilterTypeSelect } from './filter-type-select';

// the knobs of an empty preset (within the range of the type: the knob clamps them; Var of an EQ type, the Gain of
// its band, at 0 dB)
const defaultsOf = (type: FilterType) => ({
  cutoff: PRESET_DEFAULTS.filter.cut,
  resonance: PRESET_DEFAULTS.filter.res,
  gain: PRESET_DEFAULTS.filter.gain,
  drive: PRESET_DEFAULTS.filter.dr,
  variation: variationDefaultOf(type),
});

export const FilterSection = () => {
  const [{ $filter, $filterType, $active, $ranges, sampleRate }, { toggleActive, setType, setNumericValue }] =
    useFilter();
  const active = useBehaviorSubject($active);
  const filter = useBehaviorSubject($filter);
  const filterType = useBehaviorSubject($filterType);
  const ranges = useBehaviorSubject($ranges);
  const defaults = React.useMemo(() => defaultsOf(filterType), [filterType]);
  // the amounts in the scale of the knob for the type (a knob the type doesn't use is disabled: its routes hide)
  const knob = (param: FilterNumerics) => filterTargetScale(filterType, param);
  const modulation = {
    cutoff: useKnobModulation('filter.cutoff', knob('cutoff')),
    resonance: useKnobModulation('filter.resonance', knob('resonance')),
    gain: useKnobModulation('filter.gain', knob('gain')),
    drive: useKnobModulation('filter.drive', knob('drive')),
    variation: useKnobModulation('filter.var', knob('variation')),
  };

  return (
    <Section name='Filter' active={active} onClick={toggleActive}>
      <Filter
        {...filter}
        type={filterType}
        typeSelect={<FilterTypeSelect type={filterType} setType={setType} />}
        ranges={ranges}
        setNumericValue={setNumericValue}
        active={active}
        sampleRate={sampleRate}
        modulation={modulation}
        defaults={defaults}
      />
    </Section>
  );
};
