import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { Dropdown, Tooltip } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import { AiOutlineClose, AiOutlineDown, AiOutlineLink, AiOutlineSave } from 'react-icons/ai';
import { CLIP_NAME_MAX_LENGTH } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { Bar, BarTitle, DirtyDot, Key, Spacer } from '../../../common/components';
import { saveFile } from '../../../common/services';
import { useTrack } from '../modules/track';
import { midiFileName, writeMidiFile } from '../midi-file';
import { ExportWav } from './export-wav-dialog';
import { DownloadIcon, Ext, ImportIcon, NewClipIcon, ShortcutsIcon } from './header-icons';
import { ShortcutsPopover } from './roll-shortcuts';
import { SaveKind } from './use-clip-saving';
import { RollEditor } from './use-roll-editor';

const WHITE = theme.colors.white;

// the name of the clip, typed where it is: as wide as it (the dot of a clip not saved right after it)
const Name = styled.input`
  flex: 0 1 auto;
  min-width: 60px;
  height: 22px;
  padding: 0 6px;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: ${WHITE};
  font: inherit;
  transition: background 150ms;

  &::placeholder {
    color: ${hexToRgba(WHITE, 0.65)};
  }

  &:hover {
    background: ${hexToRgba(WHITE, 0.18)};
  }

  &:focus {
    outline: none;
    background: ${hexToRgba(theme.colors.primaryDark, 0.25)};
  }
`;

// a section of the keys of the header (the clip, its files, its link): a plate of the gray of the bar a little
// darker, its keys a line of the gray of the bar apart (as the groups of the strip on the screen). Empty (no .wav
// outside the synth): none
const Segment = styled.div`
  flex: none;
  display: flex;
  align-items: stretch;
  height: 22px;
  margin: 0 2px;
  border-radius: 3px;
  background: ${hexToRgba(theme.colors.primaryDark, 0.12)};

  &:empty {
    display: none;
  }

  /* a key in a tooltip's wrapper (a key that tells why it is off) */
  & > span {
    display: flex;
  }

  && > * + * {
    border-left: 1px solid ${theme.colors.primaryLowContrast};
  }

  & button {
    height: auto;
    border-radius: 0;
  }

  /* lit over the plate (the light of a key of the bar would be the gray of the bar again) */
  && button:hover:not(:disabled):not(:active) {
    background: ${hexToRgba(WHITE, 0.3)};
  }

  & > :first-child,
  & > :first-child > button {
    border-top-left-radius: 3px;
    border-bottom-left-radius: 3px;
  }

  & > :last-child,
  & > :last-child > button {
    border-top-right-radius: 3px;
    border-bottom-right-radius: 3px;
  }

  && .square {
    width: 20px;
  }
`;

// a key with its tooltip (as the keys of the strip: after a while)
const TipKey = ({ tip, ...props }: React.ComponentProps<typeof Key> & { tip: string }) => (
  <Tooltip title={tip} mouseEnterDelay={0.5}>
    <Key {...props} />
  </Tooltip>
);

// a .mid in place of the notes (the key, or a file dropped on the roll)
export const readMidiFile = (file: File, importMidi: (bytes: ArrayBuffer) => boolean) =>
  file.arrayBuffer().then(importMidi);

interface Props {
  editor: RollEditor;
  onSave: (kind: SaveKind) => void;
  saving: boolean;
  // none: a phone (the screen of the clip stays)
  onClose?: () => void;
  // a phone: the name, Save and Share
  compact?: boolean;
}

// the header of the roll, as a section of the synth: CLIP, its name (typed there) and whether it is saved; the list of
// the keys; then its sections: the clip (a new one, a .mid imported), its files (the notes as a .mid, the sound as a
// .wav: a phone too, its icon alone), its link (Save, a new link from its menu, Share); Close
export const RollHeader = ({ editor, onSave, saving, onClose, compact = false }: Props) => {
  const [{ $clip, $dirty }, actions] = useTrack();
  const clip = useBehaviorSubject($clip);
  const dirty = useBehaviorSubject($dirty);
  const file = React.useRef<HTMLInputElement>(null);
  return (
    <Bar data-testid='roll-header'>
      <BarTitle>CLIP</BarTitle>
      <Name
        placeholder='Untitled'
        maxLength={CLIP_NAME_MAX_LENGTH}
        value={clip.name ?? ''}
        onChange={(e) => actions.setName(e.target.value)}
        aria-label='Clip name'
        spellCheck={false}
        size={Math.max(8, (clip.name ?? '').length + 1)}
      />
      {dirty && <DirtyDot title='Not saved' role='img' aria-label='Not saved' />}
      <Spacer />
      {!compact && (
        <>
          <ShortcutsPopover open={editor.shortcutsOpen} onOpenChange={editor.setShortcutsOpen}>
            <Key className={cls('square', { open: editor.shortcutsOpen })} aria-label='Shortcuts'>
              <ShortcutsIcon />
            </Key>
          </ShortcutsPopover>
          <input
            ref={file}
            type='file'
            accept='.mid,.midi,audio/midi,audio/x-midi'
            hidden
            data-testid='midi-file'
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) readMidiFile(chosen, actions.importMidi);
              e.target.value = '';
            }}
          />
          <Segment role='group' aria-label='Clip'>
            <TipKey aria-label='New clip' tip='A new empty clip' onClick={actions.newClip}>
              <NewClipIcon />
              New
            </TipKey>
            <TipKey
              aria-label='Import'
              tip='Import a .mid (or drop one on the roll)'
              onClick={() => file.current?.click()}
            >
              <ImportIcon />
              Import
            </TipKey>
          </Segment>
        </>
      )}
      <Segment role='group' aria-label='Download'>
        {!compact && (
          <TipKey
            aria-label='Export MIDI'
            tip='Download the notes of the clip as a .mid'
            onClick={() =>
              saveFile(new Blob([writeMidiFile(clip)], { type: 'audio/midi' }), midiFileName(clip))
            }
          >
            <DownloadIcon />
            <Ext>.mid</Ext>
          </TipKey>
        )}
        <ExportWav compact={compact} />
      </Segment>
      <Segment role='group' aria-label='Link'>
        <TipKey disabled={saving} onClick={() => onSave('save')} tip='Save the clip'>
          {saving ? <LoadingOutlined /> : <AiOutlineSave />}
          Save
        </TipKey>
        {!compact && (
          <Dropdown
            trigger={['click']}
            placement='bottomRight'
            menu={{ items: [{ key: 'new', label: 'Save as a new link' }], onClick: () => onSave('new') }}
          >
            <Key className='square' aria-label='More ways to save' disabled={saving}>
              <AiOutlineDown />
            </Key>
          </Dropdown>
        )}
        <TipKey onClick={() => onSave('share')} tip='Copy link to clip'>
          <AiOutlineLink />
          Share
        </TipKey>
      </Segment>
      {onClose && (
        <TipKey className='square' aria-label='Close' tip='Close the piano roll' onClick={onClose}>
          <AiOutlineClose />
        </TipKey>
      )}
    </Bar>
  );
};
