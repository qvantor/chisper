import { MdPiano } from 'react-icons/md';
import { styled } from 'styled-components';
import { Label, Lamp, Select, PanelButton } from '@chisper/ui-kit';
import { useState } from 'react';
import { Popover } from 'antd';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { useMidiController } from '../common/modules';

const Content = styled.div`
  min-width: 300px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

// a label sits closer to its select than to the field above
const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

// the lamp and its name: a press anywhere on it switches it (the lamp's click bubbles to it: once, keyboard too)
const Switch = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  user-select: none;
  cursor: pointer;
`;

const ALL_CHANNELS = 'all';
// midi always exposes 16 channels per input, there is no way to know which of them are in use
const channelOptions = [
  { name: 'All channels', value: ALL_CHANNELS },
  ...Array.from({ length: 16 }, (_, i) => ({ name: `Channel ${i + 1}`, value: String(i) })),
];

const CLOCK_SYNC = 'Sync to MIDI Clock';

// the tempo, Start and Stop of the MIDI input lead the synth, or the tempo of the roll plays; none without WebMIDI
// (or its permission)
const ClockSync = () => {
  const [{ $midiAccess, $clockSync }, { setClockSync }] = useMidiController();
  const access = useBehaviorSubject($midiAccess);
  const on = useBehaviorSubject($clockSync);
  if (!access) return null;
  return (
    <Switch onClick={() => setClockSync(!on)}>
      <Lamp on={on} label={CLOCK_SYNC} />
      <Label>{CLOCK_SYNC}</Label>
    </Switch>
  );
};

export const MidiInput = () => {
  const [open, setOpen] = useState(false);
  const [{ $midiInputs, $selectedInputId, $selectedChannel }, { selectMidiInput, selectMidiChannel }] =
    useMidiController();
  const midiInputs = useBehaviorSubject($midiInputs);
  const selected = useBehaviorSubject($selectedInputId);
  const selectedChannel = useBehaviorSubject($selectedChannel);
  return (
    <Popover
      trigger='click'
      placement='bottom'
      content={
        <Content>
          <Field>
            <Label>Midi source</Label>
            <Select
              value={selected ?? ''}
              options={midiInputs.map((input) => ({
                name: `${input.manufacturer} ${input.name}`,
                value: input.id,
              }))}
              onChange={selectMidiInput}
            />
          </Field>
          <Field>
            <Label>Midi channel</Label>
            <Select
              value={selectedChannel === null ? ALL_CHANNELS : String(selectedChannel)}
              options={channelOptions}
              onChange={(value) => selectMidiChannel(value === ALL_CHANNELS ? null : Number(value))}
            />
          </Field>
          <ClockSync />
        </Content>
      }
      open={open}
      onOpenChange={setOpen}
    >
      <PanelButton icon={<MdPiano />} active={open} indicator={selected !== null}>
        Midi
      </PanelButton>
    </Popover>
  );
};
