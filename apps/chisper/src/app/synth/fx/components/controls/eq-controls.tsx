import React from 'react';
import { mapValues } from 'lodash';
import { EQ_PASS, eqTypeOf } from '@chisper/math/eq';
import { eq } from '../../effects/eq';
import { EQ_BANDS } from '../../effects/eq-params';
import { EqParam } from '../../effects/eq-presets';
import { KnobModulation, useKnobModulation } from '../../../modulation/use-knob-modulation';
import { EqScreen } from './eq-screen';
import { EQ_TYPE_ICONS } from './eq-type-icons';
import { ControlsGroup, LastGroups } from './group';
import { ParamHandle } from './param-handle';
import { ParamSwitch } from './param-switch';
import { FxControlsProps } from './types';

const { params: defs } = eq;

// groups left to right: band 1 (its type, frequency, resonance, gain) | the curve (the screen: the points of the
// bands dragged on it) | band 2 | post (level); the mix is the common Out of FxPanel. A pass takes no gain: its knob
// is off
export const EqControls = ({ params, setParam, on, sampleRate, out }: FxControlsProps) => {
  // the knobs the screen draws: it follows where their routes move them
  const charted: Partial<Record<EqParam, KnobModulation>> = {
    f1: useKnobModulation('eq.f1'),
    q1: useKnobModulation('eq.q1'),
    g1: useKnobModulation('eq.g1'),
    f2: useKnobModulation('eq.f2'),
    q2: useKnobModulation('eq.q2'),
    g2: useKnobModulation('eq.g2'),
  };
  const modulations = mapValues(charted, (modulation) => modulation?.modulations);
  const handle = (key: Exclude<EqParam, 't1' | 't2'>, disabled = false) => (
    <ParamHandle
      def={defs[key]}
      value={params[key]}
      onChange={(value) => setParam(key, value)}
      disabled={!on || disabled}
      target={`eq.${key}`}
      modulation={charted[key]}
    />
  );
  const band = (index: number) => {
    const { type, freq, reso, gain } = EQ_BANDS[index];
    return (
      <ControlsGroup caption={`Band ${index + 1}`} disabled={!on}>
        <ParamSwitch
          def={defs[type]}
          icons={EQ_TYPE_ICONS[index]}
          value={params[type]}
          onChange={(value) => setParam(type, value)}
          target={`eq.${type}`}
          disabled={!on}
        />
        {handle(freq)}
        {handle(reso)}
        {handle(gain, eqTypeOf(params[type]) === EQ_PASS)}
      </ControlsGroup>
    );
  };
  return (
    <>
      {band(0)}
      <ControlsGroup caption='Curve' disabled={!on}>
        <EqScreen
          params={params}
          setParam={setParam}
          sampleRate={sampleRate}
          modulations={modulations}
          active={on}
        />
      </ControlsGroup>
      {band(1)}
      <LastGroups>
        <ControlsGroup caption='Post' disabled={!on}>
          {handle('level')}
        </ControlsGroup>
        {out}
      </LastGroups>
    </>
  );
};
