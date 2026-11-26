import React from 'react';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { Filter, FilterNumerics, Section } from '@chisper/ui-kit';
import { useFilter } from '../modules';
import { filterDefaultsOf } from '../constants';
import { useKnobModulation } from '../../modulation/use-knob-modulation';
import { filterTargetScale } from '../../common/modulation/modulation-targets';
import { FilterTypeSelect } from './filter-type-select';

export const FilterSection = () => {
  const [{ $filter, $filterType, $active, $ranges, sampleRate }, { toggleActive, setType, setNumericValue }] =
    useFilter();
  const active = useBehaviorSubject($active);
  const filter = useBehaviorSubject($filter);
  const filterType = useBehaviorSubject($filterType);
  const ranges = useBehaviorSubject($ranges);
  // (the defaults of the knobs: those of an empty preset)
  const defaults = React.useMemo(() => filterDefaultsOf(filterType), [filterType]);
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
    <Section name='Filter' active={active} onClick={toggleActive} midiTarget='filter.on'>
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
