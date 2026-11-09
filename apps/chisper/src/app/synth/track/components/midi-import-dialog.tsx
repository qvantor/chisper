import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { Checkbox } from 'antd';
import { AiOutlineUpload } from 'react-icons/ai';
import { textBold12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import {
  Bar,
  Dialog,
  DialogIntro,
  DialogScreen,
  Key,
  ScreenHead,
  screenCheckStyle,
  screenScrollStyle,
  Spacer,
} from '../../../common/components';
import { midiName } from '../../services';
import { MidiPart } from '../midi-file';
import { PendingMidi, useTrack } from '../modules/track';
import { notesLabel } from '../track-edit';

const { colors } = theme;

const Screen = styled(DialogScreen)`
  max-height: 50vh;
`;

// All over the parts, the parts scrolled where there are many (a song of 16 channels, tracks of a DAW)
const All = styled(ScreenHead)`
  padding: 8px 11px;

  .ant-checkbox-label {
    ${textBold12};
    color: ${colors.primaryDarkHighContrast};
    letter-spacing: 1px;
    text-transform: uppercase;
  }
`;

const Parts = styled.div`
  ${screenScrollStyle};
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px;
`;

// a part: its name white while it is checked, dimmed while not; its box on the line of its name
const Part = styled.div`
  ${screenCheckStyle};

  .ant-checkbox-label {
    flex-direction: column;
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
    <Dialog title='Import MIDI' open={pending !== null} onCancel={cancelImport} width={440} destroyOnHidden>
      <DialogIntro>The file has {parts.length} parts: choose those to import.</DialogIntro>
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
  );
};
