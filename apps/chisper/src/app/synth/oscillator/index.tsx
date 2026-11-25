import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { Handle, HandleProps, theme } from '@chisper/ui-kit';
import { useBehaviorSubject, useBehaviorSubjectField } from '@chisper/rxjs-react';
import { number } from '@chisper/math';
import { OSC_DEFAULTS } from '@chisper/preset-schema';
import { OscillatorActions, OscillatorModel, useOscillator1 } from '../common/modules';
import { OSC_PRECISION } from '../common/modules/oscillator';
import { RxHandle } from '../../common/components';
import { useKnobModulation } from '../modulation/use-knob-modulation';
import { OscillatorContext, useCompact, useHeld, useOscillatorContext } from './hooks';
import { formatWavePosition, WarpMode, Wave, WaveSelector } from './components';

export { useOscillatorContext };

const Root = styled.div`
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 5px;
`;

// the table: as wide as the oscillator whatever its name (cut in its middle)
const Table = styled.div`
  contain: inline-size;
`;

const Handles = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
`;

const HandlesGroup = styled.div`
  display: flex;
  gap: 10px;
`;

// the Warp knob and the plate of its mode right of it, in a faint outline of their own; its padding and edge out of
// the row (the knob level with the others, the row no wider)
const WarpGroup = styled.div`
  display: flex;
  gap: 2px;
  margin: -3px;
  padding: 2px;
  border: 1px solid ${hexToRgba(theme.colors.primaryDarkMediumContrast, 0.12)};
  border-radius: ${theme.borderRadius.l};
`;

// a knob of a value of $osc (the unison detune, its blend): it renders itself on a change, not the oscillator (Oct,
// Semi, Fine, the phases and the unison render their strips)
const OscKnob = ({
  $osc,
  field,
  ...props
}: Omit<HandleProps, 'value'> & { $osc: OscillatorModel['$osc']; field: 'detune' | 'blend' }) => (
  <Handle {...props} value={useBehaviorSubjectField($osc, field)} />
);

type Props = OscillatorModel &
  OscillatorActions & {
    useOscillator: typeof useOscillator1;
    // the prefix of its modulation targets (osc1.gain…)
    target?: 'osc1' | 'osc2';
  };

export const Oscillator = ({
  $osc,
  $position,
  $frames,
  $gain,
  $warpMode,
  $warp,
  ranges,
  setOscValue,
  useOscillator,
  setPosition,
  setGain,
  setWarp,
  target = 'osc1',
}: Props) => {
  const oscillator = useOscillator();
  // narrow (a phone, a narrow window): the strips of values smaller, the plate of the Warp mode its glyph alone
  const [rootRef, compact] = useCompact<HTMLDivElement>();
  // Detune, Blend and Unison held: the chart shows the voices of the unison (the overlay renders, not the oscillator)
  const [$unisonHeld, holdUnison] = useHeld();
  // the frames played (of an expanded table 256)
  const frames = useBehaviorSubject($frames);
  const gainModulation = useKnobModulation(`${target}.gain`);
  const waveModulation = useKnobModulation(`${target}.wave`);
  const detuneModulation = useKnobModulation(`${target}.detune`);
  const blendModulation = useKnobModulation(`${target}.blend`);
  const warpModulation = useKnobModulation(`${target}.warp`);
  // Off: the Warp knob is grey (its routes are not shown)
  const warping = useBehaviorSubject($warpMode) !== 0;
  const unison = React.useMemo(
    () => ({
      $visible: $unisonHeld,
      detune: detuneModulation.modulations,
      blend: blendModulation.modulations,
    }),
    [$unisonHeld, detuneModulation.modulations, blendModulation.modulations]
  );

  return (
    <OscillatorContext.Provider value={oscillator}>
      <Root ref={rootRef}>
        <Table>
          <WaveSelector />
        </Table>
        <Wave
          modulations={waveModulation.modulations}
          warpModulations={warpModulation.modulations}
          target={target}
          unison={unison}
          onUnisonActiveChange={holdUnison}
          compact={compact}
        />
        <Handles>
          <HandlesGroup>
            <RxHandle
              min={0}
              max={1}
              $value={$gain}
              label='Gain'
              name='Volume'
              onChange={setGain}
              formatValue={(value) => number.percent(number.round(value, 100))}
              precision={OSC_PRECISION.gain}
              defaultValue={OSC_DEFAULTS.g}
              {...gainModulation}
            />
          </HandlesGroup>
          <HandlesGroup>
            {/* steps by whole frames, the label is the frame from 1 */}
            <RxHandle
              min={0}
              max={Math.max(0, frames - 1)}
              $value={$position}
              label='Wave'
              name='Wave position'
              onChange={setPosition}
              precision={OSC_PRECISION.wave}
              formatValue={formatWavePosition}
              defaultValue={OSC_DEFAULTS.w}
              {...waveModulation}
            />
            <WarpGroup>
              <RxHandle
                min={0}
                max={1}
                $value={$warp}
                label='Warp'
                name='Warp amount'
                onChange={setWarp}
                formatValue={(value) => number.percent(number.round(value, 100))}
                precision={OSC_PRECISION.warp}
                defaultValue={OSC_DEFAULTS.wa}
                disabled={!warping}
                {...warpModulation}
              />
              <WarpMode compact={compact} target={target} />
            </WarpGroup>
          </HandlesGroup>
          <HandlesGroup>
            <OscKnob
              $osc={$osc}
              field='detune'
              label='Detune'
              name='Unison detune'
              min={ranges.detune[0]}
              max={ranges.detune[1]}
              onChange={(value) => setOscValue('detune', Math.round(value * 100000) / 100000)}
              precision={OSC_PRECISION.detune}
              defaultValue={OSC_DEFAULTS.d}
              onActiveChange={holdUnison}
              {...detuneModulation}
            />
            {/* the level of the centre voices of the unison against the others: 0 the centre, the others 27 dB
            under it; 100% the others, the centre under them (the curves of the reference AU) */}
            <OscKnob
              $osc={$osc}
              field='blend'
              label='Blend'
              name='Unison blend'
              min={ranges.blend[0]}
              max={ranges.blend[1]}
              onChange={(value) => setOscValue('blend', value)}
              formatValue={(value) => number.percent(number.round(value, 100))}
              precision={OSC_PRECISION.blend}
              defaultValue={OSC_DEFAULTS.b}
              onActiveChange={holdUnison}
              {...blendModulation}
            />
          </HandlesGroup>
        </Handles>
      </Root>
    </OscillatorContext.Provider>
  );
};
