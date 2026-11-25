import { mapValues } from 'lodash';
import { filterModel } from '@chisper/math';
import { fxfilter } from '../../effects/fxfilter';
import { FxFilterParam } from '../../effects/fxfilter-presets';
import { fxFilterTypeOf } from '../../effects/fxfilter-params';
import { KnobModulation, useKnobModulation } from '../../../modulation/use-knob-modulation';
import { FxFilterScreen } from './fxfilter-screen';
import { FxFilterTypePlate } from './fxfilter-type-plate';
import { ControlsGroup, LastGroups } from './group';
import { ParamHandle } from './param-handle';
import { FxControlsProps } from './types';

const { params: defs } = fxfilter;

// groups left to right: the filter (its type on a plate left of the screen, as high: the keys of the categories over
// its name between ◀ ▶; the screen: the response, its grip dragged across for the cutoff and up and down for the
// resonance) | its knobs: Cutoff, Res, Drive, Fat (off where the type reads none), Pan | post (level); the mix is the
// common Out of FxPanel
export const FxFilterControls = ({ params, setParam, on, sampleRate, out }: FxControlsProps) => {
  // the knobs the screen draws: it follows where their routes move them
  const charted: Partial<Record<FxFilterParam, KnobModulation>> = {
    cutoff: useKnobModulation('fxfilter.cutoff'),
    res: useKnobModulation('fxfilter.res'),
    drive: useKnobModulation('fxfilter.drive'),
    var: useKnobModulation('fxfilter.var'),
    pan: useKnobModulation('fxfilter.pan'),
    level: useKnobModulation('fxfilter.level'),
  };
  const modulations = mapValues(charted, (modulation) => modulation?.modulations);
  const type = fxFilterTypeOf(params['type']);
  const uses = filterModel.modelKnobsOf(type);
  const handle = (key: Exclude<FxFilterParam, 'type'>, disabled = false) => (
    <ParamHandle
      def={defs[key]}
      value={params[key]}
      onChange={(value) => setParam(key, value)}
      disabled={!on || disabled}
      target={`fxfilter.${key}`}
      modulation={charted[key]}
    />
  );
  return (
    <>
      <ControlsGroup caption='Filter' disabled={!on}>
        <FxFilterTypePlate type={type} on={on} setParam={setParam} />
        <FxFilterScreen
          params={params}
          setParam={setParam}
          sampleRate={sampleRate}
          modulations={modulations}
          resonance={uses.resonance}
          active={on}
        />
      </ControlsGroup>
      <ControlsGroup caption='Knobs' disabled={!on}>
        {handle('cutoff')}
        {handle('res', !uses.resonance)}
        {handle('drive')}
        {handle('var', !uses.variation)}
        {handle('pan')}
      </ControlsGroup>
      <LastGroups>
        <ControlsGroup caption='Post' disabled={!on}>
          {handle('level')}
        </ControlsGroup>
        {out}
      </LastGroups>
    </>
  );
};
