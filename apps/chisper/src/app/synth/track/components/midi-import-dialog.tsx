import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { Checkbox, ConfigProvider, Modal } from 'antd';
import { AiOutlineClose, AiOutlineUpload } from 'react-icons/ai';
import { checkboxLit, checkboxOff, text12, textBold12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { midiName } from '../../services';
import { MidiPart } from '../midi-file';
import { PendingMidi, useTrack } from '../modules/track';
import { notesLabel } from '../track-edit';
import { Bar, barStyle, Key, keyStyle, screenStyle } from './roll-section';

const { colors } = theme;

// the boxes of antd in the colors of the checkboxes of the synth, its states the rules below don't reach (a hover)
const CHECKBOX_THEME = {
  components: {
    Checkbox: {
      colorPrimary: colors.secondAccent,
      colorPrimaryHover: colors.secondAccent,
      colorBgContainer: colors.primaryHighContrast,
      colorBorder: colors.primaryDarkMediumContrast,
      controlInteractiveSize: 12,
      borderRadiusSM: 3,
    },
  },
};

// a section of the synth over the roll, as the roll is: its header (the title, the close key), the dark screen of the
// parts, a bar of keys under it; doubled (&&) over the rules of antd
const Dialog = styled(Modal)`
  && .ant-modal-container {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border-radius: 3px;
    background: ${colors.primary};
    box-shadow: 0 4px 12px rgb(0 0 0 / 25%);
  }

  && .ant-modal-header {
    ${barStyle};
    margin: 0;
    padding-right: 30px;
    border-bottom: none;
  }

  && .ant-modal-title {
    ${textBold12};
    color: ${colors.white};
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }

  && .ant-modal-close {
    ${keyStyle};
    top: 9px;
    inset-inline-end: 9px;
    width: 24px;
    padding: 0;
    justify-content: center;
  }

  && .ant-modal-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0;
  }

  && .ant-checkbox {
    ${checkboxOff};
  }

  && .ant-checkbox-checked {
    ${checkboxLit};
  }

  // lit, as the checkboxes of the synth: no tick
  && .ant-checkbox-checked::after {
    display: none;
  }

  && .ant-checkbox-indeterminate::after {
    width: 6px;
    height: 6px;
    border-radius: 1px;
    background: ${colors.secondAccent};
  }
`;

const Intro = styled.div`
  ${text12};
  padding: 2px 2px 0;
  color: ${colors.primaryDarkMediumContrast};
`;

// the parts on the screen of the roll: All over them, the parts scrolled where there are many (a song of 16
// channels, tracks of a DAW)
const Screen = styled.div`
  ${screenStyle};
  display: flex;
  flex-direction: column;
  max-height: 50vh;
  overflow: hidden;
`;

const All = styled.div`
  flex: none;
  display: flex;
  padding: 8px 11px;
  border-bottom: 1px solid ${hexToRgba(colors.white, 0.08)};

  .ant-checkbox-label {
    ${textBold12};
    color: ${colors.primaryDarkHighContrast};
    letter-spacing: 1px;
    text-transform: uppercase;
  }
`;

const Parts = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: ${colors.primaryDarkMediumContrast} transparent;
`;

// a part: its name white while it is checked, dimmed while not; its box on the line of its name
const Part = styled.div`
  padding: 5px 8px;
  border-radius: 2px;
  transition: background 120ms;

  &:hover {
    background: ${hexToRgba(colors.white, 0.05)};
  }

  .ant-checkbox-wrapper {
    align-items: flex-start;
  }

  .ant-checkbox {
    align-self: flex-start;
    margin-top: 2px;
  }

  .ant-checkbox-label {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
`;

const Name = styled.span`
  ${textBold12};
  line-height: 16px;
  color: ${colors.white};
  overflow-wrap: anywhere;
  transition: color 120ms;

  .off & {
    color: ${colors.primaryMediumContrast};
  }
`;

const Details = styled.span`
  font-size: 12px;
  line-height: 16px;
  color: ${colors.primaryDarkHighContrast};
`;

const Count = styled.span`
  color: ${hexToRgba(colors.white, 0.75)};
  letter-spacing: 1px;
`;

const Spacer = styled.div`
  flex: 1 1 0;
`;

// its channel, its program where its name isn't that, its notes and their range
const partDetails = ({ channel, name, program, notes, low, high }: MidiPart) =>
  [
    `Ch ${channel}`,
    program !== null && program !== name && program,
    notesLabel(notes),
    low === high ? midiName(low) : `${midiName(low)}–${midiName(high)}`,
  ]
    .filter(Boolean)
    .join(' · ');

// checked as the dialog opens: every part but the drums (a synth would play their notes as pitches), all of them
// where every one is drums
const initialChecks = (parts: readonly MidiPart[]) => {
  const melodic = parts.some((part) => !part.drums);
  return parts.map((part) => !part.drums || !melodic);
};

// the parts of a .mid of several (a channel of a track each) to import into the clip, chosen by their checkboxes
export const MidiImportDialog = () => {
  const [{ $midiImport }, { importParts, cancelImport }] = useTrack();
  const pending = useBehaviorSubject($midiImport);
  const parts = pending?.parts ?? [];
  // the checks of the file waiting: those of another file start again
  const [checks, setChecks] = React.useState<{ of: PendingMidi | null; checked: boolean[] }>({
    of: null,
    checked: [],
  });
  const checked = checks.of === pending ? checks.checked : initialChecks(parts);
  const setChecked = (next: boolean[]) => setChecks({ of: pending, checked: next });
  const count = checked.filter(Boolean).length;
  return (
    <ConfigProvider theme={CHECKBOX_THEME}>
      <Dialog
        title='Import MIDI'
        open={pending !== null}
        onCancel={cancelImport}
        closeIcon={<AiOutlineClose />}
        footer={null}
        width={440}
        centered
        destroyOnHidden
        styles={{ mask: { background: hexToRgba(colors.primaryDark, 0.55) } }}
      >
        <Intro>The file has {parts.length} parts: choose those to import.</Intro>
        <Screen data-testid='midi-parts'>
          <All>
            <Checkbox
              checked={count === parts.length}
              indeterminate={count > 0 && count < parts.length}
              onChange={(e) => setChecked(parts.map(() => e.target.checked))}
            >
              All
            </Checkbox>
          </All>
          <Parts>
            {parts.map((part, index) => (
              <Part key={`${part.track}:${part.channel}`} className={cls({ off: !checked[index] })}>
                <Checkbox
                  checked={checked[index]}
                  onChange={(e) => setChecked(checked.map((on, i) => (i === index ? e.target.checked : on)))}
                >
                  <Name>{part.name}</Name>
                  <Details>{partDetails(part)}</Details>
                </Checkbox>
              </Part>
            ))}
          </Parts>
        </Screen>
        <Bar>
          <Count>
            {count} of {parts.length}
          </Count>
          <Spacer />
          <Key onClick={cancelImport}>Cancel</Key>
          <Key
            disabled={count === 0}
            onClick={() => importParts(checked.flatMap((on, index) => (on ? [index] : [])))}
          >
            <AiOutlineUpload />
            Import
          </Key>
        </Bar>
      </Dialog>
    </ConfigProvider>
  );
};
