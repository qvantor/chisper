import React from 'react';
import { styled } from 'styled-components';
import { filterModel } from '@chisper/math';
import { Handle } from '../handle';
import { CommonFilterProps, FilterNumerics, FilterRange, FilterRanges, FilterParams } from './types';
import { FilterResponse } from './components/filter-response';
import { filterKnobLooks } from './services/knobs';

export type { FilterNumerics, FilterParams, FilterRange, FilterRanges };
export { FilterResponse };
export { frequencyResponseDb } from './services';

const Root = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 5px;
`;

const Chart = styled(FilterResponse)`
  flex: 1 1;
`;

export const HandlersContainer = styled.div`
  display: flex;
  gap: 10px;
`;

export const Filter = ({
  type,
  typeSelect,
  setNumericValue,
  ranges,
  active = true,
  sampleRate,
  cutoff,
  resonance,
  gain,
  drive,
  variation,
  modulation = {},
  defaults = {},
}: CommonFilterProps) => {
  // the knobs of the type: Gain of a BiquadFilterNode (disabled where it doesn't use it, as before), Drive and Var of
  // a model type (Var: Comp, or the Gain of an EQ one); their labels, names and units by the type
  const model = filterModel.isModelFilterType(type);
  const looks = React.useMemo(() => filterKnobLooks(type), [type]);
  const values = { cutoff, resonance, gain, drive, variation };
  const knob = (key: FilterNumerics) => (
    <Handle
      key={key}
      value={values[key]}
      onChange={(next) => setNumericValue(key, next)}
      label={looks[key].label}
      name={looks[key].name}
      formatValue={looks[key].format}
      defaultValue={defaults[key]}
      {...ranges[key]}
      {...modulation[key]}
    />
  );
  return (
    <Root>
      {typeSelect}
      <Chart
        type={type}
        cutoff={cutoff}
        resonance={resonance}
        gain={gain}
        drive={drive}
        variation={variation}
        sampleRate={sampleRate}
        active={active}
        ranges={ranges}
        modulations={{
          cutoff: modulation.cutoff?.modulations,
          resonance: modulation.resonance?.modulations,
          gain: modulation.gain?.modulations,
          drive: modulation.drive?.modulations,
          variation: modulation.variation?.modulations,
        }}
      />
      <HandlersContainer>
        {knob('cutoff')}
        {knob('resonance')}
        {model ? [knob('drive'), knob('variation')] : knob('gain')}
      </HandlersContainer>
    </Root>
  );
};
