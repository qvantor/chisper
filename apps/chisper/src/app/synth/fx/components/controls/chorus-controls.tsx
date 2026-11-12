import React from 'react';
import { styled } from 'styled-components';
import { HighPassIcon, SwitchKey } from '@chisper/ui-kit';
import { chorus, chorusDivisionHz, chorusDivisionOf, chorusStepsOf } from '../../effects/chorus';
import type { ChorusMeterValues } from '../../effects/chorus-params';
import { ChorusParam } from '../../effects/chorus-presets';
import type { FxMeter } from '../../effects/types';
import { ChorusScreen } from './chorus-screen';
import { ControlsGroup, LastGroups } from './group';
import { ParamHandle } from './param-handle';
import { DivisionHandle, KeysPlate, TempoKeys } from './tempo-keys';
import { FxControlsProps } from './types';

const { params: defs } = chorus;

// the key of the high pass alone on its plate: its icon (the response of the filter) as large as a plate of this
// size takes
const FilterPlate = styled(KeysPlate)`
  && svg {
    width: 26px;
    height: 26px;
  }
`;

// the high pass alone on its plate, all of it (as BPM beside Release of an envelope). Memoized: the controls
// render on every move of a knob, a key is a tooltip
const FilterKey = React.memo(
  ({ on, high, setParam }: Pick<FxControlsProps, 'on' | 'setParam'> & { high: boolean }) => (
    <FilterPlate aria-label='Filter type' disabled={!on} disabledHint='Turn on the chorus' stack>
      <SwitchKey
        icon={<HighPassIcon />}
        name='High pass'
        hint='The filter cuts the lows of the wet signal, not its highs'
        on={high}
        onChange={(value) => setParam('hpf', +value)}
      />
    </FilterPlate>
  )
);

type ChorusKnob = Exclude<ChorusParam, 'sync' | 'div' | 'trip' | 'dot' | 'hpf'>;

// three groups left to right: the LFO (rate, with BPM over TRIP and DOT beside it, depth) | the taps (their
// screen, where they move and are dragged, delay 1, delay 2, feedback) | post (the filter of the wet signal with its type beside it, the level); the mix is the
// common one of FxPanel, which lays the groups out. In BPM Rate is a division of the tempo
export const ChorusControls = ({ params, setParam, on, out, meter }: FxControlsProps) => {
  const sync = params['sync'] >= 0.5;
  // Rate in BPM: a cycle of the LFO a division (8 bar … 1/32, by TRIP and DOT), right faster
  const division = (
    <DivisionHandle
      target='chorus.rate'
      def={defs.rate}
      divDef={defs.div}
      steps={chorusStepsOf(params)}
      division={chorusDivisionOf(params)}
      valueOf={chorusDivisionHz}
      setParam={setParam}
      disabled={!on}
    />
  );
  const handle = (key: ChorusKnob) => (
    <ParamHandle
      def={defs[key]}
      value={params[key]}
      onChange={(value) => setParam(key, value)}
      disabled={!on}
      target={`chorus.${key}`}
    />
  );
  return (
    <>
      <ControlsGroup caption='LFO' disabled={!on}>
        {sync ? division : handle('rate')}
        <TempoKeys
          of='Rate'
          effect='chorus'
          on={on}
          sync={sync}
          trip={params['trip'] >= 0.5}
          dot={params['dot'] >= 0.5}
          setParam={setParam}
        />
        {handle('depth')}
      </ControlsGroup>
      <ControlsGroup caption='Taps' disabled={!on}>
        <ChorusScreen
          params={params}
          setParam={setParam}
          meter={meter as FxMeter<ChorusMeterValues> | undefined}
          active={on}
        />
        {handle('d1')}
        {handle('d2')}
        {handle('fb')}
      </ControlsGroup>
      <LastGroups>
        <ControlsGroup caption='Post' disabled={!on}>
          {handle('cut')}
          <FilterKey on={on} high={params['hpf'] >= 0.5} setParam={setParam} />
          {handle('level')}
        </ControlsGroup>
        {out}
      </LastGroups>
    </>
  );
};
