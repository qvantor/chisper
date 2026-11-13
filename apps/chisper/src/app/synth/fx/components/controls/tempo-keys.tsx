import React from 'react';
import { styled } from 'styled-components';
import { Handle, SwitchKey, SwitchKeys } from '@chisper/ui-kit';
import { ParamRange, TEMPO_DIVISIONS } from '@chisper/preset-schema';
import { NoteValueKeys } from '../../../../common/components';
import { useKnobModulation } from '../../../modulation/use-knob-modulation';
import { useStepTravel } from '../../../modulation/step-travel';
import { FxParamDef } from '../../effects/types';
import { FxControlsProps } from './types';

// a plate of keys beside a knob, as large as its ring (KNOB_RING, over its label: KNOB_LABEL), 4 px from it (the gap
// of the knobs is 10)
const KNOB_RING = 48;
const KNOB_LABEL = 15;
export const KeysPlate = styled(SwitchKeys)`
  width: ${KNOB_RING}px;
  height: ${KNOB_RING}px;
  margin: 0 0 ${KNOB_LABEL + 1}px -6px;
`;

interface Props extends Pick<FxControlsProps, 'on' | 'setParam'>, Record<'sync' | 'trip' | 'dot', boolean> {
  // the knob they are beside (Time, Rate) and its effect (delay, chorus)
  of: string;
  effect: string;
}

// BPM over TRIP and DOT on one plate beside the knob of a time: its params `sync`, `trip` and `dot`. Memoized: the
// controls render on every move of a knob, a key is a tooltip
export const TempoKeys = React.memo(({ of, effect, on, sync, trip, dot, setParam }: Props) => (
  <KeysPlate aria-label='Tempo' disabled={!on} disabledHint={`Turn on the ${effect}`} stack>
    <SwitchKey
      label='BPM'
      name='Tempo sync'
      hint={`${of} in note values`}
      on={sync}
      onChange={(value) => setParam('sync', +value)}
    />
    <NoteValueKeys
      of={of}
      bpm={sync}
      trip={trip}
      dot={dot}
      onTrip={(value) => setParam('trip', +value)}
      onDot={(value) => setParam('dot', +value)}
    />
  </KeysPlate>
));

const formatDivision = (division: number) => TEMPO_DIVISIONS[division]?.id ?? '';

interface DivisionProps extends Pick<FxControlsProps, 'setParam'> {
  // the knob in BPM (`delay.time`): its routes are those of the knob
  target: string;
  def: Pick<FxParamDef, 'label' | 'name'>;
  // its param `div`
  divDef: ParamRange;
  // the divisions it steps over and the one it is at
  steps: number[];
  division: number;
  // a division in the units of the knob at a tempo
  valueOf: (division: number, bpm: number) => number;
  disabled: boolean;
}

// a knob of a time in BPM: its divisions by TRIP and DOT; its routes those of the knob (in its units: their arc and
// mark on its steps at the tempo)
export const DivisionHandle = ({
  target,
  def,
  divDef,
  steps,
  division,
  valueOf,
  setParam,
  disabled,
}: DivisionProps) => {
  const modulation = useKnobModulation(target);
  const modTravel = useStepTravel(target, steps, division, valueOf);
  return (
    <Handle
      label={def.label}
      name={def.name}
      min={0}
      max={divDef.max}
      step={steps}
      precision={1}
      value={division}
      modTravel={modTravel}
      formatValue={formatDivision}
      defaultValue={divDef.default}
      onChange={(division) => setParam('div', division)}
      disabled={disabled}
      {...modulation}
    />
  );
};
