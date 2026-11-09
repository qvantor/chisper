import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { MdFiberManualRecord, MdPlayArrow, MdStop } from 'react-icons/md';
import {
  AiOutlineColumnWidth,
  AiOutlineEdit,
  AiOutlineRedo,
  AiOutlineSound,
  AiOutlineUndo,
  AiOutlineZoomIn,
  AiOutlineZoomOut,
} from 'react-icons/ai';
import {
  ActionKey,
  DragValue,
  FollowIcon,
  LegatoIcon,
  QuantizeIcon,
  SelectIcon,
  SnapIcon,
  SwitchKey,
  SwitchKeys,
  theme,
} from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { Spacer } from '../../../common/components';
import { useTrack } from '../modules/track';
import { GRID_STEPS, gridIndex } from '../track-edit';
import { PositionDisplay } from './play-position';
import { KEYS } from './roll-shortcuts';
import { TempoDisplay } from './tempo-display';
import { RollEditor } from './use-roll-editor';

const LINE = `1px solid ${theme.colors.primaryDarkMediumContrast}`;

// a strip of the screen of the roll, over it: its groups by what they do, apart, the view on its right end; scrolled
// across where it doesn't fit
const Root = styled.div`
  flex: none;
  display: flex;
  gap: 6px;
  height: 32px;
  padding: 3px;
  border-bottom: ${LINE};
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
`;

// a group: a plate of its own, a little lighter than the screen, its parts (values, keys) a line apart
const Group = styled.div`
  flex: none;
  display: flex;
  align-items: stretch;
  height: 100%;
  overflow: hidden;
  border-radius: 3px;
  background: ${hexToRgba(theme.colors.primaryDarkMediumContrast, 0.45)};

  & > * + * {
    border-left: ${LINE};
  }

  /* its plates of keys on its plate */
  & > [role='group'] {
    background: transparent;
    border-radius: 0;
  }
`;

// a value of the strip, as tall as it
const Value = styled(DragValue)`
  align-items: center;
  height: 100%;
  padding: 0 8px;
  border-radius: 0;

  .compact & {
    padding: 0 6px;
  }
`;

interface Props {
  editor: RollEditor;
  // a phone: Play, the position, the grid, undo and redo
  compact?: boolean;
}

// over the roll, in groups: the transport (Play, REC: the notes of the inputs into the loop, where the output plays,
// the tempo of the synth: the display of the settings, shown only while a MIDI Clock leads it), the grid and its snap, the tools (select or draw, the sound of the edits), the edits of all or the
// selected notes, undo and redo; on the right the view (following the playhead, the zoom). The loop follows the
// notes: no length here, its flag on the ruler
export const RollStrip = ({ editor, compact = false }: Props) => {
  const [{ $history, $armed, $recording }, actions] = useTrack();
  const history = useBehaviorSubject($history);
  const armed = useBehaviorSubject($armed);
  const recording = useBehaviorSubject($recording);
  return (
    <Root className={cls({ compact })} data-testid='roll-strip'>
      {/* the transport: Play, where the output plays, the tempo */}
      <Group role='group' aria-label='Transport'>
        <SwitchKeys aria-label='Play'>
          <SwitchKey
            on={armed}
            onChange={(on) => (on ? actions.play() : actions.stop())}
            name={armed ? 'Stop the track' : 'Play the track'}
            icon={armed ? <MdStop /> : <MdPlayArrow />}
            hint={KEYS.play}
          />
          {/* REC: lit red while it records */}
          <SwitchKey
            on={recording}
            lit={theme.colors.red}
            onChange={(on) => (on ? actions.record() : actions.stopRecording())}
            name={recording ? 'Stop recording' : 'Record'}
            icon={<MdFiberManualRecord />}
            hint={`The notes of the computer keyboard, the piano and MIDI into the clip, over its notes; the loop runs on a bar at a time (up to 32); from a stop it plays · ${KEYS.record}`}
          />
        </SwitchKeys>
        <PositionDisplay />
        {/* the tempo of the clip is the tempo of the synth */}
        {!compact && <TempoDisplay />}
      </Group>
      {/* the grid and its snap */}
      <Group role='group' aria-label='Grid'>
        <Value
          label='GRID'
          name='Grid'
          value={gridIndex(editor.grid)}
          min={0}
          max={GRID_STEPS.length - 1}
          precision={1}
          travel={120}
          formatValue={(index) => GRID_STEPS[index].id}
          onChange={(index) => editor.setGrid(GRID_STEPS[index].id)}
        />
        {!compact && (
          <SwitchKeys aria-label='Snap'>
            <SwitchKey
              on={editor.snap}
              onChange={editor.setSnap}
              name='Snap to the grid'
              icon={<SnapIcon />}
              hint='Alt while dragging: off the grid'
            />
          </SwitchKeys>
        )}
      </Group>
      {/* the tools: select or draw (one of them on: a press on the other switches, the keys too), the sound of the
          edits */}
      {!compact && (
        <Group role='group' aria-label='Tools'>
          <SwitchKeys aria-label='Mode'>
            <SwitchKey
              on={editor.mode === 'select'}
              onChange={() => editor.setMode('select')}
              name='Select notes'
              icon={<SelectIcon />}
              hint={`Click or drag a rectangle to select, drag to move, double-click to add · ${KEYS.draw}`}
            />
            <SwitchKey
              on={editor.mode === 'draw'}
              onChange={() => editor.setMode('draw')}
              name='Draw notes'
              icon={<AiOutlineEdit />}
              hint={`Click and drag to draw; a note: select and drag it; right click takes it away · ${KEYS.draw}`}
            />
          </SwitchKeys>
          <SwitchKeys aria-label='Sound'>
            <SwitchKey
              on={editor.sound}
              onChange={editor.setSound}
              name='Sound of the edits'
              icon={<AiOutlineSound />}
              hint='Hear the notes as they are added and selected'
            />
          </SwitchKeys>
        </Group>
      )}
      {/* the edits of the selected notes, or of all */}
      {!compact && (
        <Group role='group' aria-label='Edits'>
          <SwitchKeys aria-label='Edits of the notes'>
            <ActionKey
              name='Quantize'
              icon={<QuantizeIcon />}
              hint={`To the grid: the selected notes, or all · ${KEYS.quantize}`}
              onClick={editor.quantize}
            />
            <ActionKey
              name='Legato'
              icon={<LegatoIcon />}
              hint={`Each up to the next note · ${KEYS.legato}`}
              onClick={editor.legato}
            />
          </SwitchKeys>
        </Group>
      )}
      {/* the undo */}
      <Group role='group' aria-label='History'>
        <SwitchKeys aria-label='Undo and redo'>
          <ActionKey
            name='Undo'
            icon={<AiOutlineUndo />}
            hint={KEYS.undo}
            disabled={!history.past.length}
            onClick={editor.undo}
          />
          <ActionKey
            name='Redo'
            icon={<AiOutlineRedo />}
            hint={KEYS.redo}
            disabled={!history.future.length}
            onClick={editor.redo}
          />
        </SwitchKeys>
      </Group>
      {/* the view, on the right end: following the playhead, the zoom */}
      {!compact && (
        <>
          <Spacer />
          <Group role='group' aria-label='View'>
            <SwitchKeys aria-label='Follow'>
              <SwitchKey
                on={editor.follow}
                onChange={editor.setFollow}
                name='Follow the playhead'
                icon={<FollowIcon />}
                hint={`The view pages with it · ${KEYS.follow}`}
              />
            </SwitchKeys>
            <SwitchKeys aria-label='Zoom'>
              <ActionKey
                name='Zoom out'
                icon={<AiOutlineZoomOut />}
                hint={KEYS.zoomOut}
                onClick={editor.zoomOut}
              />
              <ActionKey
                name='Fit the bars'
                icon={<AiOutlineColumnWidth />}
                hint={KEYS.fit}
                onClick={editor.fit}
              />
              <ActionKey
                name='Zoom in'
                icon={<AiOutlineZoomIn />}
                hint={KEYS.zoomIn}
                onClick={editor.zoomIn}
              />
            </SwitchKeys>
          </Group>
        </>
      )}
    </Root>
  );
};
