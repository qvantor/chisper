import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { theme } from '@chisper/ui-kit';
import { screenStyle, SECTION_SHADOW } from '../../../common/components';
import { useTrack } from '../modules/track';
import { MidiImportDialog } from './midi-import-dialog';
import { PianoRoll } from './piano-roll';
import { readMidiFile, RollHeader } from './roll-header';
import { RollStrip } from './roll-strip';
import { useClipSaving } from './use-clip-saving';
import { useRollEditor } from './use-roll-editor';
import { useRollKeys } from './use-roll-keys';

// over the synth as the editor of the wavetables is, from under the header to over the row of the keys: the keys
// and the preview of the clip stay (a click on the preview closes it). A section of the synth: its header, then the
// screen of the roll with its strip over it
const Root = styled.div<{ $bottom: number }>`
  position: fixed;
  top: 80px;
  left: 0;
  right: 0;
  bottom: ${({ $bottom }) => $bottom}px;
  // over the dots of the routes of the knobs (4), under the tooltips and menus
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  background: ${theme.colors.primary};
  box-shadow: ${SECTION_SHADOW};
  outline: none;
`;

// the screen of the roll: the dark of the charts, sunk into the section; a .mid over it lights its edge
const Screen = styled.div`
  ${screenStyle};
  position: relative;
  flex: 1 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: box-shadow 150ms;

  &.dropping {
    box-shadow:
      inset 0 1px 3px rgb(0 0 0 / 50%),
      0 0 0 2px ${theme.colors.accent},
      0 0 12px ${hexToRgba(theme.colors.accent, 0.5)};
  }
`;

const isMidiFile = (file: File) => /\.midi?$/i.test(file.name) || /midi/.test(file.type);

interface Props {
  // px under it: the row of the keys
  bottom: number;
  // the preset a shared link opens with (null: none, or its sound was changed)
  presetId: () => string | null;
}

// the piano roll of the clip of the track: its header, its strip and the roll; its keys wherever the focus is while
// it is open (the roll takes the focus as it opens); a .mid dropped on it is imported (the parts of a file of several
// chosen in a dialog beside it: React bubbles the events of a portal through its parents)
export const RollWindow = ({ bottom, presetId }: Props) => {
  const [, { setRollOpen, importMidi }] = useTrack();
  const editor = useRollEditor();
  useRollKeys(editor);
  const { save, busy, captcha } = useClipSaving(presetId);
  const [dropping, setDropping] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-roll-focus]')?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <Root
        ref={root}
        $bottom={bottom}
        data-testid='roll-window'
        onDragOver={(e) => {
          e.preventDefault();
          if (!dropping) setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDropping(false);
          const file = e.dataTransfer.files[0];
          if (file && isMidiFile(file)) readMidiFile(file, importMidi);
        }}
      >
        <RollHeader editor={editor} onSave={save} saving={busy} onClose={() => setRollOpen(false)} />
        <Screen className={cls({ dropping })}>
          <RollStrip editor={editor} />
          <PianoRoll editor={editor} />
        </Screen>
        {captcha}
      </Root>
      <MidiImportDialog />
    </>
  );
};
