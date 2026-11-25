import React from 'react';
import { DottedIcon, SwitchKey, TripletIcon } from '@chisper/ui-kit';

const TRIPLET = <TripletIcon />;
const DOTTED = <DottedIcon />;
const BPM_OFF = 'Turn on BPM to use it';

interface Props {
  // what they lengthen or shorten (Time, Rate)
  of: string;
  // they work only in BPM
  bpm: boolean;
  trip: boolean;
  dot: boolean;
  onTrip: (on: boolean) => void;
  onDot: (on: boolean) => void;
  // the prefix of the ids of MIDI Learn of the keys (lfo1: lfo1.trip, lfo1.dot)
  midiTarget?: string;
}

// TRIP and DOT on a plate of the keys of the tempo (SwitchKeys), after BPM: a time in triplets and in dotted notes
export const NoteValueKeys = ({ of, bpm, trip, dot, onTrip, onDot, midiTarget }: Props) => (
  <>
    <SwitchKey
      icon={TRIPLET}
      name='Triplets'
      hint={`${of} in triplets: ⅔ as long`}
      disabledHint={BPM_OFF}
      on={trip}
      disabled={!bpm}
      onChange={onTrip}
      midiTarget={midiTarget && `${midiTarget}.trip`}
    />
    <SwitchKey
      icon={DOTTED}
      name='Dotted'
      hint={`${of} in dotted notes: 1.5× as long`}
      disabledHint={BPM_OFF}
      on={dot}
      disabled={!bpm}
      onChange={onDot}
      midiTarget={midiTarget && `${midiTarget}.dot`}
    />
  </>
);
