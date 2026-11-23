import React from 'react';
import { styled } from 'styled-components';
import { Handle, Section, textBold12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject, useBehaviorSubjectField } from '@chisper/rxjs-react';
import { number } from '@chisper/math';
import { MacroId, MACROS } from '@chisper/preset-schema';
import { useEnvelopes, useModulation } from '../common/modules';
import { SourceTab } from '../modulation/source-tabs';
import { SOURCE_LABELS } from '../envelope/envelope-colors';

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

// a row: its tab on the grey of a header (its type too), the knob at its right
const Row = styled.div`
  container-type: inline-size;
  min-height: 0;
  display: flex;
  align-items: center;
  gap: 2px;
`;

const Strip = styled.div`
  flex: 1 1;
  min-width: 0;
  display: flex;
  white-space: nowrap;
  ${textBold12};

  /* (narrow: the dot and the number in it) */
  & > button {
    padding: 0 4px;
    gap: 4px;
  }
  padding: 2px;
  border-radius: 3px;
  background: ${theme.colors.primaryLowContrast};
`;

const Knob = styled.div`
  flex: none;
  margin: -4px 0;
`;

// its number, MACRO N in a row of a section of 150 px and more (its padding 10 a side)
const Short = styled.span`
  @container (min-width: 130px) {
    display: none;
  }
`;
const Long = styled.span`
  display: none;

  @container (min-width: 130px) {
    display: inline;
  }
`;

const formatLevel = (value: number) => number.percent(number.round(value, 100));

// the tab of a macro: selected, the knobs show its routes; dragged onto a knob it assigns the macro to it. It renders
// on the selected source (its tab the number of its routes)
const MacroTab = ({ id, index }: { id: MacroId; index: number }) => {
  const [{ $selected }, { select }] = useEnvelopes();
  const selected = useBehaviorSubject($selected) === id;
  return (
    <Strip>
      <SourceTab
        id={id}
        selected={selected}
        onSelect={select}
        aria-pressed={selected}
        aria-label={SOURCE_LABELS[id]}
        grip={false}
      >
        <Short>{index + 1}</Short>
        <Long>{SOURCE_LABELS[id]}</Long>
      </SourceTab>
    </Strip>
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
        precision={100}
        name={SOURCE_LABELS[id]}
        formatValue={formatLevel}
        defaultValue={0}
        onChange={(value) => setMacro(id, value)}
      />
    </Knob>
  );
};

// MACRO 1–4 left of ENV, one under another: the tab of each (a source of the modulation as ENV and the LFOs: a knob
// it is dropped on follows its level, with a note or without one) and its knob, its level. The levels are in the
// preset; the voices and the effects glide to a new one
export const MacrosSection = () => (
  <Section name='Macros'>
    <Frame>
      <Rows>
        {MACROS.map((id, index) => (
          <Row key={id}>
            <MacroTab id={id} index={index} />
            <MacroKnob id={id} index={index} />
          </Row>
        ))}
      </Rows>
    </Frame>
  </Section>
);
