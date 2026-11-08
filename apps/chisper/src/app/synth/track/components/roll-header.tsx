import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { Dropdown, Tooltip } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import {
  AiOutlineClose,
  AiOutlineDown,
  AiOutlineDownload,
  AiOutlineFileAdd,
  AiOutlineLink,
  AiOutlineQuestion,
  AiOutlineSave,
  AiOutlineUpload,
} from 'react-icons/ai';
import { CLIP_NAME_MAX_LENGTH } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { useTrack } from '../modules/track';
import { midiFileName, writeMidiFile } from '../midi-file';
import { Bar, BarTitle, Key } from './roll-section';
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

// not saved: the dot of the preset that is not, of its color
const Dirty = styled.span`
  flex: none;
  width: 7px;
  height: 7px;
  margin: 0 4px;
  border-radius: 50%;
  background: ${theme.colors.secondAccent};
`;

const Spacer = styled.div`
  flex: 1 1 0;
`;

const Divider = styled.span`
  flex: none;
  width: 1px;
  height: 14px;
  margin: 0 4px;
  background: ${hexToRgba(WHITE, 0.45)};
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

const download = (bytes: Uint8Array<ArrayBuffer>, name: string) => {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

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
// the keys, a .mid imported or exported, a new clip, Save (a new link from its menu), Share, Close
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
      {dirty && <Dirty title='Not saved' role='img' aria-label='Not saved' />}
      <Spacer />
      {!compact && (
        <>
          <ShortcutsPopover open={editor.shortcutsOpen} onOpenChange={editor.setShortcutsOpen}>
            <Key className={cls('square', { open: editor.shortcutsOpen })} aria-label='Shortcuts'>
              <AiOutlineQuestion />
            </Key>
          </ShortcutsPopover>
          <Divider />
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
          <TipKey
            aria-label='Import'
            tip='Import a .mid (or drop one on the roll)'
            onClick={() => file.current?.click()}
          >
            <AiOutlineUpload />
            Import
          </TipKey>
          <TipKey
            aria-label='Export'
            tip='Export a .mid'
            onClick={() => download(writeMidiFile(clip), midiFileName(clip))}
          >
            <AiOutlineDownload />
            Export
          </TipKey>
          <TipKey aria-label='New clip' tip='A new empty clip' onClick={actions.newClip}>
            <AiOutlineFileAdd />
            New
          </TipKey>
          <Divider />
        </>
      )}
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
      {onClose && (
        <>
          <Divider />
          <TipKey className='square' aria-label='Close' tip='Close the piano roll' onClick={onClose}>
            <AiOutlineClose />
          </TipKey>
        </>
      )}
    </Bar>
  );
};
