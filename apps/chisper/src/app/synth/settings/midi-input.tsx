import React from 'react';
import { MdPiano } from 'react-icons/md';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { styled } from 'styled-components';
import { distinctUntilChanged, map } from 'rxjs';
import {
  indicatorDot,
  keepFocus,
  Lamp,
  LampLight,
  PanelButton,
  text10,
  text12,
  textBold12,
  theme,
} from '@chisper/ui-kit';
import { useBehaviorSubject, useObservable } from '@chisper/rxjs-react';
import {
  ChoiceKeys,
  GroupLabel,
  PopoverGroup,
  PopoverNote,
  screenItemStyle,
  screenScrollStyle,
  SectionPopover,
} from '../../common/components';
import { useMidiController, useTransport } from '../common/modules';
import { useLights } from './use-lights';

const { colors } = theme;

// the IN of the header and its lamp, lit while the input holds a note
const Activity = styled.span`
  ${text10};
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 6px;
  color: ${hexToRgba(colors.white, 0.85)};
  font-weight: 600;
  letter-spacing: 1px;
`;

// the inputs, one under the other (a few rows, then a scroll)
const Inputs = styled.div`
  ${screenScrollStyle};
  max-height: 136px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0 -3px;
`;

// a row of an input (a click listens to it): white under the pointer as the keys of the header, the one listened to
// in blue with a line of it on its left, as the current preset of the browser
const Input = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${screenItemStyle};
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: ${colors.white};
  }

  &[aria-checked='true'] {
    background: ${hexToRgba(colors.secondAccent, 0.1)};
    box-shadow: inset 2px 0 0 ${colors.secondAccent};
  }

  &:focus-visible {
    outline: 1px solid ${colors.secondAccent};
    outline-offset: -1px;
  }
`;

const InputName = styled.span`
  ${textBold12};
  flex: 1 1 auto;
  min-width: 0;
  line-height: 16px;
  color: ${colors.primaryDarkMediumContrast};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  [aria-checked='true'] > & {
    color: ${colors.secondAccent};
  }
`;

const Maker = styled.span`
  ${text10};
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  color: ${colors.primaryHighContrast};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

// all the channels on the left across both rows, 1–8 over 9–16 (as the matrix of a hardware synth)
const Channels = styled.div`
  & > [role='radiogroup'] {
    display: grid;
    grid-template-columns: 46px repeat(8, 1fr);
  }

  & [data-value='all'] {
    grid-row: span 2;
    height: auto;
  }

  & [role='radio'] {
    padding: 0;
  }
`;

// the lamp and its name: a press anywhere on it switches it (the lamp's click bubbles to it: once, keyboard too); the
// state of the clock on the right
const Clock = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 1px;
  user-select: none;
  cursor: pointer;
`;

const ClockName = styled.span`
  ${textBold12};
  color: ${colors.primaryDarkMediumContrast};
`;

// the tempo a clock leads after a green dot, as the dot of the MIDI key
const ClockState = styled.span`
  ${text12};
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  color: ${colors.primaryHighContrast};
  font-variant-numeric: tabular-nums;
  white-space: nowrap;

  &.leads {
    ${textBold12};
    color: ${colors.primaryDarkMediumContrast};
  }

  &.leads::before {
    content: '';
    ${indicatorDot};
  }
`;

const ALL_CHANNELS = 'all';
// midi always exposes 16 channels per input, there is no way to know which of them are in use
const channelOptions = [
  { value: ALL_CHANNELS, label: 'All', name: 'All channels' },
  ...Array.from({ length: 16 }, (_, i) => ({
    value: String(i),
    label: String(i + 1),
    name: `Channel ${i + 1}`,
  })),
];

const CLOCK_SYNC = 'Sync to MIDI Clock';

// the lamp of the header: lit while the input holds a note, of any channel
const ActivityLamp = () => {
  const [{ $heldChannels }] = useMidiController();
  const lamp = React.useRef<HTMLSpanElement>(null);
  const $any = React.useMemo(() => $heldChannels.pipe(map((mask) => (mask === 0 ? 0 : 1))), [$heldChannels]);
  useLights(
    $any,
    1,
    React.useCallback(() => lamp.current, []),
    'on'
  );
  return (
    <Activity>
      IN
      <LampLight ref={lamp} color={colors.accent} />
    </Activity>
  );
};

const InputList = () => {
  const [{ $midiInputs, $selectedInputId }, { selectMidiInput }] = useMidiController();
  const inputs = useBehaviorSubject($midiInputs);
  const selected = useBehaviorSubject($selectedInputId);
  if (inputs.length === 0)
    return <PopoverNote>No MIDI device connected. Plug one in, it shows up here.</PopoverNote>;
  return (
    <Inputs role='radiogroup' aria-label='MIDI input'>
      {inputs.map(({ id, name, manufacturer }) => {
        const label = name || 'Unknown';
        return (
          <Input
            key={id}
            role='radio'
            aria-checked={id === selected}
            aria-label={manufacturer ? `${label}, ${manufacturer}` : label}
            onClick={() => id !== selected && selectMidiInput(id)}
          >
            <InputName>{label}</InputName>
            {manufacturer && <Maker>{manufacturer}</Maker>}
          </Input>
        );
      })}
    </Inputs>
  );
};

// the channel listened to; a key lights a dot while the input holds a note of its channel (the one a keyboard sends on
// shows)
const ChannelKeys = () => {
  const [{ $selectedChannel, $heldChannels }, { selectMidiChannel }] = useMidiController();
  const channel = useBehaviorSubject($selectedChannel);
  const root = React.useRef<HTMLDivElement>(null);
  useLights(
    $heldChannels,
    16,
    React.useCallback((bit: number) => root.current?.querySelector(`[data-value='${bit}']`), []),
    'signal'
  );
  return (
    <Channels ref={root}>
      <ChoiceKeys
        aria-label='MIDI channel'
        options={channelOptions}
        value={channel === null ? ALL_CHANNELS : String(channel)}
        onChange={(value) => selectMidiChannel(value === ALL_CHANNELS ? null : Number(value))}
      />
    </Channels>
  );
};

// the tempo, Start and Stop of the MIDI input lead the synth, or the tempo of the roll plays: whether a clock leads
// it now, at what tempo
const ClockSync = () => {
  const [{ $clockSync }, { setClockSync }] = useMidiController();
  const [{ $source, $tempo }] = useTransport();
  const on = useBehaviorSubject($clockSync);
  const leads = useBehaviorSubject($source) === 'midi';
  // whole: the tempo of a clock wavers in its decimals
  const $bpm = React.useMemo(() => $tempo.pipe(map(Math.round), distinctUntilChanged()), [$tempo]);
  const bpm = useObservable($bpm, Math.round($tempo.value));
  const state = () => {
    if (!on) return 'Off';
    return leads ? `${bpm} BPM` : 'Waiting for a clock';
  };
  return (
    <Clock onClick={() => setClockSync(!on)}>
      <Lamp on={on} label={CLOCK_SYNC} />
      <ClockName>{CLOCK_SYNC}</ClockName>
      <ClockState className={cls({ leads: on && leads })}>{state()}</ClockState>
    </Clock>
  );
};

const MidiGroups = () => (
  <>
    <PopoverGroup>
      <GroupLabel>Input</GroupLabel>
      <InputList />
    </PopoverGroup>
    <PopoverGroup>
      <GroupLabel>Channel</GroupLabel>
      <ChannelKeys />
    </PopoverGroup>
    <PopoverGroup>
      <ClockSync />
    </PopoverGroup>
  </>
);

const NoMidi = () => (
  <PopoverGroup>
    <PopoverNote>MIDI isn&apos;t available: no Web MIDI in this browser, or access was denied.</PopoverNote>
  </PopoverGroup>
);

export const MidiInput = () => {
  const [open, setOpen] = React.useState(false);
  const [{ $midiAccess, $selectedInputId }] = useMidiController();
  // none without WebMIDI (or its permission): no groups, no lamp
  const access = useBehaviorSubject($midiAccess);
  const selected = useBehaviorSubject($selectedInputId);
  return (
    <SectionPopover
      title='MIDI'
      extra={access && <ActivityLamp />}
      content={access ? <MidiGroups /> : <NoMidi />}
      width={320}
      open={open}
      onOpenChange={setOpen}
    >
      <PanelButton icon={<MdPiano />} active={open} indicator={selected !== null}>
        Midi
      </PanelButton>
    </SectionPopover>
  );
};
