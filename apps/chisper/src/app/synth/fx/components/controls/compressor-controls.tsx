import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { DragValue, theme } from '@chisper/ui-kit';
import { compressor, formatBandThresholds } from '../../effects/compressor';
import { CompressorParam } from '../../effects/compressor-presets';
import { useKnobModulation } from '../../../modulation/use-knob-modulation';
import { bandLimit, BandParam, bandValue, CompressorScreen, SCREEN_SIZE } from './compressor-screen';
import { ControlsGroup, LastGroups } from './group';
import { ParamHandle } from './param-handle';
import { ParamSwitch } from './param-switch';
import { FxControlsProps } from './types';

const { params: defs } = compressor;
// the threshold knob of three bands tells the thresholds of the bands, not the one of one band
const BANDS_THRESH = { ...defs.thresh, formatValue: formatBandThresholds };

// px of the windows of the crossovers and of the gains (the longest value of each)
const WIDTHS = { Crossovers: 104, 'Band gains': 92 };

// the screen and the windows at its sides (three bands) as one display: a line between them, its corners round;
// as wide in one band, where the screen is all of it
const Display = styled.div`
  flex: none;
  display: flex;
  width: ${WIDTHS.Crossovers + SCREEN_SIZE[0] + WIDTHS['Band gains'] + 2}px;
  overflow: hidden;
  border-radius: 3px;
  background: ${theme.colors.primaryDark};

  & > * + * {
    border-left: 1px solid ${theme.colors.primaryDarkMediumContrast};
  }
`;

// the params of the bands in windows at the sides of the screen (they are dragged on it as well): each takes the
// envelopes and the LFOs as a knob does, its routes on the line along its bottom
const Values = styled.div`
  flex: none;
  display: flex;
  flex-direction: column;
  height: ${SCREEN_SIZE[1]}px;
  transition: opacity 150ms;

  /* bypassed, only shown: its values fade, the display stays as dark */
  &.off > * {
    opacity: 0.5;
  }
`;

// a value in its window: its name at the left, the values in a column at the right; the line of its routes
// fainter than on a strip of values: it is under every one of them here
const Value = styled(DragValue)`
  --drag-value-track: ${hexToRgba(theme.colors.white, 0.08)};
  flex: 1 1 0;
  align-items: center;
  padding: 0 7px;
  border-radius: 0;

  & > span:first-child {
    flex: 1 1 auto;
  }

  & + & {
    border-top: 1px solid ${theme.colors.primaryDarkMediumContrast};
  }
`;

// the crossovers left of the screen, the gains of the bands right of it (as the rows of the bands of the screen:
// the high one at the top)
const CROSSOVERS: BandParam[] = ['xhigh', 'xlow'];
const GAINS: BandParam[] = ['high', 'mid', 'low'];

// what each does, told by its tooltip
const HINTS: Record<BandParam, string> = {
  xlow: 'Where the low band ends and the mid band starts',
  xhigh: 'Where the mid band ends and the high band starts',
  low: 'The level of the low band after its compression',
  mid: 'The level of the mid band after its compression',
  high: 'The level of the high band after its compression',
};

interface BandValueProps {
  param: BandParam;
  value: number;
  setParam: (key: string, value: number) => void;
  // bypassed: only shown, takes no routes
  off: boolean;
  // where a value it is set to stops (a crossover at the other one)
  limit: (param: BandParam, value: number) => number;
}

// (memoized: a param dragged renders only its own value)
const BandValue = React.memo(({ param, value, setParam, off, limit }: BandValueProps) => {
  const { label, name, min, max, precision, mode, formatValue, default: defaultValue } = defs[param];
  const modulation = useKnobModulation(`compressor.${param}`);
  const format = React.useCallback((shown: number) => `${formatValue?.(shown) ?? shown}`, [formatValue]);
  const onChange = React.useCallback(
    (next: number) => setParam(param, limit(param, next)),
    [setParam, param, limit]
  );
  return (
    <Value
      label={label}
      name={name}
      value={value}
      min={min}
      max={max}
      precision={precision}
      mode={mode}
      hint={HINTS[param]}
      formatValue={format}
      {...(!off && { onChange, defaultValue, ...modulation })}
    />
  );
});

const ModeIcon = ({ bars }: { bars: number[] }) => (
  <svg width='24' height='24' viewBox='0 0 24 24' fill='currentColor' aria-hidden>
    {bars.map((height, i) => (
      <rect
        key={i}
        x={12 - (bars.length * 6 - 2) / 2 + i * 6}
        y={19 - height}
        width='4'
        height={height}
        rx='1'
      />
    ))}
  </svg>
);
// by option id (COMPRESSOR_MODES): one band, three
const MODE_ICONS = {
  single: <ModeIcon bars={[14]} />,
  multiband: <ModeIcon bars={[10, 14, 7]} />,
};

// groups left to right: mode | the screen (the curve of one band; the three bands, whose crossovers and gains are
// dragged on it and in the windows at its sides, which take the routes: one band has none, its screen is as wide as
// all of them) | dynamics (threshold, ratio, the attack of one band or the upward ratio of three in its place,
// release, makeup gain) | post (level); the mix is the common Out of FxPanel. The value of a param the mode doesn't
// show is kept
export const CompressorControls = ({ params, setParam, on, out, meter }: FxControlsProps) => {
  const multi = Math.round(params['multi']) === 1;
  const { xlow, xhigh } = params;
  const limit = React.useMemo(() => bandLimit(xlow, xhigh), [xlow, xhigh]);
  const handle = (key: Exclude<CompressorParam, 'multi'>) => (
    <ParamHandle
      def={multi && key === 'thresh' ? BANDS_THRESH : defs[key]}
      value={params[key]}
      onChange={(value) => setParam(key, value)}
      disabled={!on}
      target={`compressor.${key}`}
    />
  );
  const values = (name: keyof typeof WIDTHS, keys: BandParam[]) => (
    <Values role='group' aria-label={name} className={cls({ off: !on })} style={{ width: WIDTHS[name] }}>
      {keys.map((key) => (
        <BandValue
          key={key}
          param={key}
          value={bandValue(key, params)}
          setParam={setParam}
          off={!on}
          limit={limit}
        />
      ))}
    </Values>
  );
  return (
    <>
      <ControlsGroup caption='Mode' disabled={!on}>
        <ParamSwitch
          def={defs.multi}
          icons={MODE_ICONS}
          value={params['multi']}
          onChange={(value) => setParam('multi', value)}
          disabled={!on}
        />
      </ControlsGroup>
      <ControlsGroup caption={multi ? 'Bands' : 'Curve'} disabled={!on}>
        <Display>
          {multi && values('Crossovers', CROSSOVERS)}
          <CompressorScreen params={params} setParam={setParam} meter={meter} multi={multi} active={on} />
          {multi && values('Band gains', GAINS)}
        </Display>
      </ControlsGroup>
      <ControlsGroup caption='Dynamics' disabled={!on}>
        {handle('thresh')}
        {handle('ratio')}
        {multi ? handle('below') : handle('attack')}
        {handle('release')}
        {handle('gain')}
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
