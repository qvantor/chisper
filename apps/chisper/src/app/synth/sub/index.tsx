import React from 'react';
import { styled } from 'styled-components';
import {
  ContiguousIcon,
  Deactivated,
  Handle,
  HandleProps,
  PulseIcon,
  RoundRectIcon,
  SawIcon,
  Section,
  SineIcon,
  SquareIcon,
  SwitchKey,
  SwitchKeys,
  theme,
  TriangleIcon,
} from '@chisper/ui-kit';
import { useBehaviorSubject, useBehaviorSubjectField } from '@chisper/rxjs-react';
import { number } from '@chisper/math';
import { SUB_DEFAULTS, SubShape } from '@chisper/preset-schema';
import { SubModel, useSub } from '../common/modules';
import type { SubNumeric } from '../common/modules/sub';
import { useKnobModulation } from '../modulation/use-knob-modulation';
import { formatPan, signed } from '../noise';
import { Cell, Strip } from '../oscillator/components/wave/value-strip';
import { SubStatus } from './sub-status';

const Root = styled.div`
  height: 100%;
  min-width: 0;
  container-type: inline-size;
`;

// narrow (the desktop), as the noise beside it: Oct in the row of the selects, the block under it in the row of the
// window of the noise (it takes the height left), the knobs in the rows of its knobs; wide (a phone): the knobs at
// their right
const Layout = styled.div`
  height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-areas: 'octave' 'block' 'knobs';
  gap: 5px;

  @container (min-width: 140px) {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      'octave knobs'
      'block knobs';
    column-gap: 8px;
  }
`;

// Oct alone, as high as the selects of the oscillators and the noise
const OctaveBar = styled.div`
  grid-area: octave;
  display: flex;
  height: 22px;
  overflow: hidden;
  border-radius: 3px;
  background: ${theme.colors.primaryDark};
`;

const OctaveValue = styled(Cell)`
  align-items: center;
  padding: 0 7px;
`;

// Crs over the keys of the shapes, Phase and Contiguous under them: one dark block, as the window of the noise
const Block = styled.div`
  grid-area: block;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: ${theme.colors.primaryDark};
  border-radius: 3px;
`;

// the shapes between the strips, where an oscillator has its wave: they take the height of the block left
const ShapesArea = styled.div`
  flex: 1 1;
  min-height: 0;
  position: relative;
  display: flex;
`;

// one key over another, every one as high
const Shapes = styled(SwitchKeys)`
  flex: 1 1;
  height: auto;
  border-radius: 0;
`;

// the sub off: the stripes of an oscillator off over its shapes, a shape still chosen through them
const Off = styled(Deactivated)`
  inset: 0;
  border-radius: 0;
  pointer-events: none;
`;

// a strip over or under the shapes
const ValueStrip = styled(Strip)`
  flex: none;
  align-items: stretch;
`;

// the label over the value: Phase and Contiguous in the width of a knob and a little
const StackCell = styled(Cell)`
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 5px 2px;
  font-size: 10px;
  line-height: 12px;
`;

// one over another as far apart as the rows of the knobs of the noise (in a wide section spread evenly along it)
const Knobs = styled.div`
  grid-area: knobs;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  align-items: center;
  gap: 4px;
`;

// px of the section on the desktop: as wide as a knob and a little
export const SUB_WIDTH = 104;
// a desktop screen too low for the knobs under the shapes (they would leave the keys under 16 px): the section as
// wide as the block with the knobs at its right
export const SUB_LOW_SCREEN = '(max-height: 790px)';
export const SUB_WIDE_WIDTH = 164;

// px of drag an octave of Oct, a semitone of Crs (as Oct and Semi of an oscillator)
const PX_PER_STEP = 10;

// the shapes on their keys, in the order of the presets (SUB_SHAPES)
const SHAPE_KEYS: { shape: SubShape; name: string; hint: string; icon: React.ReactNode }[] = [
  { shape: 'sine', name: 'Sine', hint: 'The fundamental alone: a clean, deep low end', icon: <SineIcon /> },
  {
    shape: 'round-rect',
    name: 'Rounded Rect',
    hint: 'A sine with flatter tops: a little more body than the sine',
    icon: <RoundRectIcon />,
  },
  {
    shape: 'triangle',
    name: 'Triangle',
    hint: 'Odd harmonics that fall fast: soft, a little brighter than the sine',
    icon: <TriangleIcon />,
  },
  { shape: 'saw', name: 'Saw', hint: 'Every harmonic: a bright, gritty low end', icon: <SawIcon /> },
  { shape: 'square', name: 'Square', hint: 'Odd harmonics: hollow and punchy', icon: <SquareIcon /> },
  { shape: 'pulse', name: 'Pulse', hint: 'A narrow pulse: thin and nasal', icon: <PulseIcon /> },
];

// the semitones of Crs with two decimals at most, as Semi without a unit
export const formatCoarse = (value: number) => signed(number.round(value, 100));

// a knob of a value of $sub, a route target: it renders itself on a change of its value or its routes, not the
// section
const SubKnob = ({
  $sub,
  field,
  target,
  ...props
}: Omit<HandleProps, 'value'> & { $sub: SubModel['$sub']; field: SubNumeric; target: string }) => (
  <Handle {...props} value={useBehaviorSubjectField($sub, field)} {...useKnobModulation(target)} />
);

// the shapes, one key over another: they render on the shape
const ShapeKeys = () => {
  const [{ $sub }, { setShape }] = useSub();
  const shape = useBehaviorSubjectField($sub, 'shape');
  return (
    <Shapes column aria-label='Shape'>
      {SHAPE_KEYS.map((key) => (
        <SwitchKey
          key={key.shape}
          on={shape === key.shape}
          onChange={() => setShape(key.shape)}
          name={key.name}
          hint={key.hint}
          icon={key.icon}
        />
      ))}
    </Shapes>
  );
};

// Oct over the block, with the arrows of the Oct of an oscillator: it renders on its own value
const OctaveCell = () => {
  const [{ $sub, ranges }, { setSubValue }] = useSub();
  const octave = useBehaviorSubjectField($sub, 'octave');
  const [min, max] = ranges.octave;
  return (
    <OctaveBar>
      <OctaveValue
        label='Oct'
        value={octave}
        min={min}
        max={max}
        precision={1}
        travel={(max - min) * PX_PER_STEP}
        arrows
        defaultValue={SUB_DEFAULTS.o}
        onChange={(value) => setSubValue('octave', value)}
      />
    </OctaveBar>
  );
};

// Crs over the shapes, as the Semi of an oscillator: it takes the routes of Crs (the line of its range along its bottom,
// the dot of its routes right of the value). It renders on its value and its routes
const CoarseCell = () => {
  const [{ $sub, ranges }, { setSubValue }] = useSub();
  const coarse = useBehaviorSubjectField($sub, 'coarse');
  const modulation = useKnobModulation('sub.crs');
  const [min, max] = ranges.coarse;
  return (
    <ValueStrip $edge='top' className='compact'>
      <Cell
        label='Crs'
        value={coarse}
        min={min}
        max={max}
        precision={100}
        travel={(max - min) * PX_PER_STEP}
        formatValue={formatCoarse}
        defaultValue={SUB_DEFAULTS.c}
        onChange={(value) => setSubValue('coarse', value)}
        {...modulation}
      />
    </ValueStrip>
  );
};

// Phase under the shapes, Contiguous at its right: they render on their own values
const PhaseCells = () => {
  const [{ $sub, ranges }, { setSubValue, setContiguous }] = useSub();
  const phase = useBehaviorSubjectField($sub, 'phase');
  const contiguous = useBehaviorSubjectField($sub, 'contiguous');
  return (
    <ValueStrip $edge='bottom'>
      <StackCell
        label='Phase'
        value={phase}
        min={ranges.phase[0]}
        max={ranges.phase[1]}
        cyclic
        precision={360}
        formatValue={(value) => `${Math.round(value * 360)}°`}
        defaultValue={SUB_DEFAULTS.ph}
        onChange={(value) => setSubValue('phase', value)}
      />
      <SwitchKeys aria-label='Phase of a note'>
        <SwitchKey
          on={contiguous}
          onChange={setContiguous}
          name='Contiguous'
          hint='A note starts at the phase the note before has (or had at its end), not at Phase'
          icon={<ContiguousIcon />}
        />
      </SwitchKeys>
    </ValueStrip>
  );
};

// the sub oscillator (left of the oscillators), narrow and in the lines of the noise: Oct in the row of the selects,
// Crs (a route target) over the keys of its shapes one over another (striped while it is off, why it doesn't play
// over them), Phase and Contiguous under them, the knobs Pan and Gain (route targets) one over another under it all. A value of $sub renders only what
// shows it
export const SubSection = () => {
  const [{ $active, $sub, ranges }, { toggleActive, setSubValue }] = useSub();
  const active = useBehaviorSubject($active);
  return (
    <Section name='Sub' active={active} onClick={toggleActive}>
      <Root>
        <Layout>
          <OctaveCell />
          <Block>
            <CoarseCell />
            <ShapesArea>
              <ShapeKeys />
              {!active && <Off data-testid='sub-off' />}
              <SubStatus />
            </ShapesArea>
            <PhaseCells />
          </Block>
          <Knobs>
            <SubKnob
              $sub={$sub}
              field='pan'
              target='sub.pan'
              label='Pan'
              name='Sub pan'
              min={ranges.pan[0]}
              max={ranges.pan[1]}
              precision={100}
              formatValue={formatPan}
              defaultValue={SUB_DEFAULTS.pn}
              fillFrom={0}
              onChange={(value) => setSubValue('pan', value)}
            />
            <SubKnob
              $sub={$sub}
              field='level'
              target='sub.level'
              label='Gain'
              name='Sub volume'
              min={ranges.level[0]}
              max={ranges.level[1]}
              precision={100}
              formatValue={(value) => number.percent(number.round(value, 100))}
              defaultValue={SUB_DEFAULTS.g}
              onChange={(value) => setSubValue('level', value)}
            />
          </Knobs>
        </Layout>
      </Root>
    </Section>
  );
};
