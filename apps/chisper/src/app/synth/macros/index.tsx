import React from 'react';
import { css, styled } from 'styled-components';
import cls from 'classnames';
import { MdDragIndicator } from 'react-icons/md';
import { Handle, Section, textBold12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject, useBehaviorSubjectField } from '@chisper/rxjs-react';
import { number } from '@chisper/math';
import { MACRO_NAME_MAX_LENGTH, MacroId, MACROS } from '@chisper/preset-schema';
import { useEnvelopes, useModulation } from '../common/modules';
import { MACRO_PRECISION } from '../common/modules/modulation';
import { useRouteCount, useSourceTab } from '../modulation/source-tabs';
import { SOURCE_COLORS, SOURCE_LABELS } from '../envelope/envelope-colors';

// (the folder is `macros`: an import that ends with /macro is taken for a macro of babel-plugin-macros)

// the container the rows are laid out by (a query asks an ancestor, not the element itself)
const Frame = styled.div`
  height: 100%;
  container-type: inline-size;
`;

// the rows one under another (the column of the desktop, of a row of the sections), each the height left a quarter
// (a knob reaches over its row a little: its ring has room around it); wide (a phone) the four side by side
const Rows = styled.div`
  height: 100%;
  display: grid;
  grid-template-rows: repeat(4, minmax(0, 1fr));
  gap: 2px;

  @container (min-width: 300px) {
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }
`;

// a macro: its knob and its plate in a line, the line of its name under them (kept empty while it has no routes:
// the knob stays where it is once the name shows)
const Cell = styled.div`
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
`;

// the knob, its plate at its right (the two in the middle of a wide row)
const Row = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
`;

// the line of the name of a macro under its knob and its plate
const NAME_LINE = css`
  flex: none;
  width: 100%;
  height: 16px;
  margin-top: 1px;
`;

// the line kept for the name of a macro without routes
const NameSpace = styled.div`
  ${NAME_LINE};
`;

// the name of a macro, typed where it is: the line of its name, its frame only under the pointer and while it is
// typed in; empty, the label of its macro in grey, as bold
const NameField = styled.input`
  ${NAME_LINE};
  min-width: 0;
  padding: 0 4px;
  box-sizing: border-box;
  border: none;
  border-radius: ${theme.borderRadius.s};
  background: transparent;
  color: ${theme.colors.primaryDark};
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  text-overflow: ellipsis;
  transition: background 120ms;

  &::placeholder {
    color: ${theme.colors.primaryHighContrast};
  }

  &:hover {
    background: ${theme.colors.primaryLowContrast};
  }

  &:focus {
    outline: none;
    background: ${theme.colors.white};
    box-shadow: inset 0 0 0 1px ${theme.colors.primaryMediumContrast};
  }
`;

const Knob = styled.div`
  flex: none;
  margin: -4px 0;
`;

// the plate of a macro, a key of its color (--plate-color) that is picked up: a grab cursor, its grip brighter
// under the pointer; the selected one lit, in a soft halo of its color outside its edge (a white ring inside it was
// taken for the grey around: the plate looked smaller)
const Plate = styled.button`
  flex: 1 1;
  min-width: 0;
  max-width: 110px;
  position: relative;
  padding: 0;
  border: none;
  border-radius: ${theme.borderRadius.m};
  font: inherit;
  ${textBold12};
  color: ${theme.colors.white};
  background-image: linear-gradient(rgb(255 255 255 / 16%), rgb(255 255 255 / 0%) 70%);
  box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
  cursor: grab;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  transition: box-shadow 120ms;

  &:active {
    cursor: grabbing;
  }

  &.selected {
    background-image: linear-gradient(rgb(255 255 255 / 28%), rgb(255 255 255 / 6%) 80%);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 35%),
      0 0 0 2px color-mix(in srgb, var(--plate-color) 35%, transparent),
      0 2px 10px color-mix(in srgb, var(--plate-color) 55%, transparent);
  }

  &:focus,
  &:focus-visible {
    outline: none;
  }
`;

// the container its face is laid out by: its own width
const Face = styled.span`
  display: block;
  container-type: inline-size;
`;

// narrow (the column of the desktop, a phone): the number over the grip; wider the grip and the number in a line,
// MACRO and the number wider still
const Content = styled.span`
  height: 40px;
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  justify-content: center;
  gap: 2px;
  white-space: nowrap;

  @container (min-width: 44px) {
    height: 28px;
    flex-direction: row;
    gap: 3px;
    padding: 0 4px;
  }
`;

const Grip = styled(MdDragIndicator)`
  flex: none;
  font-size: 14px;
  opacity: 0.7;
  transform: rotate(90deg);
  transition: opacity 120ms;

  ${Plate}:hover & {
    opacity: 1;
  }

  @container (min-width: 44px) {
    margin-left: -3px;
    transform: none;
  }
`;

const Short = styled.span`
  font-size: 14px;
  line-height: 1;

  @container (min-width: 44px) {
    font-size: inherit;
  }

  @container (min-width: 80px) {
    display: none;
  }
`;

const Long = styled.span`
  display: none;

  @container (min-width: 80px) {
    display: inline;
  }
`;

// the number of the routes of its macro in a white badge on its corner, of its color (none: no badge)
const Count = styled.span`
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  box-sizing: border-box;
  border-radius: 7px;
  background: ${theme.colors.white};
  box-shadow: 0 1px 2px rgb(0 0 0 / 30%);
  color: var(--plate-color);
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;

  &:empty {
    display: none;
  }
`;

const formatLevel = (value: number) => number.percent(number.round(value, 100));

// the plate of a macro, right of its knob: a click selects it (the knobs show its routes), dragged onto a knob it
// assigns the macro to it (useSourceTab). It renders on the selected source and the number of its routes
const MacroPlate = ({ id, index, count }: { id: MacroId; index: number; count: number }) => {
  const [{ $selected }, { select }] = useEnvelopes();
  const selected = useBehaviorSubject($selected) === id;
  const handlers = useSourceTab(id, select);
  const color = SOURCE_COLORS[id];
  return (
    <Plate
      type='button'
      className={cls({ selected })}
      style={{ backgroundColor: color, '--plate-color': color } as React.CSSProperties}
      aria-pressed={selected}
      aria-label={SOURCE_LABELS[id]}
      title='Drag onto a knob'
      {...handlers}
    >
      <Face>
        <Content>
          <Grip aria-hidden data-testid='macro-grip' />
          <Short>{index + 1}</Short>
          <Long>{SOURCE_LABELS[id]}</Long>
        </Content>
      </Face>
      <Count aria-hidden data-testid='route-count'>
        {count || null}
      </Count>
    </Plate>
  );
};

// the knob of a macro, its level 0..1 in %: it renders on its own level
const MacroKnob = ({ id, index }: { id: MacroId; index: number }) => {
  const [{ $macros }, { setMacro }] = useModulation();
  const level = useBehaviorSubjectField($macros, index);
  return (
    <Knob>
      <Handle
        value={level}
        min={0}
        max={1}
        precision={MACRO_PRECISION}
        name={SOURCE_LABELS[id]}
        formatValue={formatLevel}
        defaultValue={0}
        onChange={(value) => setMacro(id, value)}
        midiTarget={id}
      />
    </Knob>
  );
};

// the name of a macro under it once it has routes (one that loses its last keeps its name, hidden; its line stays):
// empty it is MACRO 1 in grey; Enter or Escape leaves it. The knobs it moves show it as the label of its routes
const MacroName = ({ id, index, routed }: { id: MacroId; index: number; routed: boolean }) => {
  const [{ $macroNames }, { setMacroName }] = useModulation();
  const name = useBehaviorSubjectField($macroNames, index);
  if (!routed) return <NameSpace aria-hidden data-testid='macro-name-space' />;
  return (
    <NameField
      value={name}
      placeholder={SOURCE_LABELS[id]}
      maxLength={MACRO_NAME_MAX_LENGTH}
      aria-label={`${SOURCE_LABELS[id]} name`}
      title={name || undefined}
      spellCheck={false}
      autoComplete='off'
      onChange={(e) => setMacroName(id, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
      }}
    />
  );
};

// a macro: its knob, its plate, its name (the number of its routes read once for the two)
const Macro = ({ id, index }: { id: MacroId; index: number }) => {
  const count = useRouteCount(id);
  return (
    <Cell>
      <Row>
        <MacroKnob id={id} index={index} />
        <MacroPlate id={id} index={index} count={count} />
      </Row>
      <MacroName id={id} index={index} routed={count > 0} />
    </Cell>
  );
};

// MACRO 1–4 left of ENV, one under another: the knob of each, its level, and its plate (a source of the modulation
// as ENV and the LFOs: a knob it is dropped on follows its level, with a note or without one), its name under them
// once it has routes. The levels and the names are in the preset; the voices and the effects glide to a new level
export const MacrosSection = () => (
  <Section name='Macros'>
    <Frame>
      <Rows>
        {MACROS.map((id, index) => (
          <Macro key={id} id={id} index={index} />
        ))}
      </Rows>
    </Frame>
  </Section>
);
