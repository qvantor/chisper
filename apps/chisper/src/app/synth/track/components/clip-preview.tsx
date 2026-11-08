import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { MdPlayArrow, MdStop } from 'react-icons/md';
import { AiOutlineExpandAlt, AiOutlineShrink } from 'react-icons/ai';
import { text10, text12, theme, useCanvas, useElementSize } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { useTrack } from '../modules/track';
import { drawPreview } from '../roll-draw';
import { lengthLabel, notesLabel } from '../track-edit';
import { PlayPosition } from './play-position';
import { usePlayhead } from './use-playhead';

// a screen of the synth: the dark of its charts; hovered (or the roll open) its edge of the accent of the loop
const Root = styled.div`
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 3px;
  background: ${theme.colors.primaryDark};
  box-shadow: inset 0 0 0 1px transparent;
  cursor: pointer;
  user-select: none;
  transition: box-shadow 150ms;

  &:not(.passive):hover,
  &.open {
    box-shadow: inset 0 0 0 1px ${theme.colors.secondAccent};
  }

  &.passive {
    cursor: default;
  }
`;

const Bar = styled.div`
  ${text12};
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 4px;
  border-bottom: 1px solid ${theme.colors.primaryDarkMediumContrast};
  color: ${theme.colors.white};
`;

const Name = styled.span`
  flex: 1 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 600;
`;

const Info = styled.span`
  ${text10};
  flex: none;
  color: ${theme.colors.primaryDarkHighContrast};
  font-weight: 600;
  white-space: nowrap;
`;

const Open = styled.span`
  flex: none;
  display: flex;
  color: ${theme.colors.primaryDarkHighContrast};
  font-size: 14px;
  transition: color 150ms;

  ${Root}:hover & {
    color: ${theme.colors.white};
  }
`;

// Play and Stop: a key of a plate of the synth, lit while the track plays
const PlayButton = styled.button`
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 2px;
  background: ${theme.colors.primaryDarkMediumContrast};
  color: ${theme.colors.primaryDarkHighContrast};
  font-size: 15px;
  cursor: pointer;
  transition:
    color 150ms,
    background 150ms;

  &:hover {
    color: ${theme.colors.white};
  }

  &.on {
    color: ${theme.colors.accent};
    background: ${hexToRgba(theme.colors.accent, 0.15)};
    filter: drop-shadow(0 0 3px ${hexToRgba(theme.colors.accent, 0.5)});
  }

  /* REC records (the roll may be closed) */
  &.on.rec {
    color: ${theme.colors.red};
    background: ${hexToRgba(theme.colors.red, 0.15)};
    filter: drop-shadow(0 0 3px ${hexToRgba(theme.colors.red, 0.5)});
  }
`;

const Chart = styled.div`
  position: relative;
  flex: 1 1;
  min-height: 0;
  margin: 4px;

  & > canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
`;

const Empty = styled.div`
  ${text10};
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: ${theme.colors.primaryDarkHighContrast};
  font-weight: 600;
  letter-spacing: 0.5px;
  pointer-events: none;
`;

// Play and Stop of the track: on while Play is (a MIDI Clock may hold the transport stopped), red while REC records
// (Stop stops it too); a click on it doesn't open the roll
const TrackPlay = () => {
  const [{ $armed, $recording }, { play, stop }] = useTrack();
  const armed = useBehaviorSubject($armed);
  const recording = useBehaviorSubject($recording);
  return (
    <PlayButton
      type='button'
      className={cls({ on: armed, rec: recording })}
      aria-label={
        !armed ? 'Play the track' : recording ? 'Stop the track and the recording' : 'Stop the track'
      }
      aria-pressed={armed}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) stop();
        else play();
      }}
    >
      {armed ? <MdStop /> : <MdPlayArrow />}
    </PlayButton>
  );
};

// the clip of the track in a small window right of the keys: its name, its length and notes, the notes over the loop
// and where the output plays; a click opens the piano roll over the synth, another one closes it (`passive`: a phone,
// whose roll is a screen of its own, shows the clip alone with its Play and position)
export const ClipPreview = ({ passive = false, className }: { passive?: boolean; className?: string }) => {
  const [{ $clip, $rollOpen }, { toggleRoll }] = useTrack();
  const clip = useBehaviorSubject($clip);
  const open = useBehaviorSubject($rollOpen);
  const [ref, [width, height]] = useElementSize<HTMLDivElement>();
  const { canvas, begin } = useCanvas(width, height);
  React.useEffect(() => {
    const context = begin();
    if (context) drawPreview(context, width, height, clip.notes, clip.length);
  }, [begin, clip.notes, clip.length, width, height]);
  const xOf = React.useCallback((tick: number) => (tick / clip.length) * width, [clip.length, width]);
  const playhead = usePlayhead(width, height, xOf);
  return (
    <Root
      className={cls(className, { open, passive })}
      {...(!passive && {
        role: 'button',
        tabIndex: -1,
        'aria-label': open ? 'Close the piano roll' : 'Open the piano roll',
        'aria-pressed': open,
        onClick: toggleRoll,
      })}
    >
      <Bar>
        <TrackPlay />
        {passive && <PlayPosition />}
        <Name>{clip.name || 'Clip'}</Name>
        <Info>
          {lengthLabel(clip.length)} · {notesLabel(clip.notes.length)}
        </Info>
        {!passive && <Open aria-hidden>{open ? <AiOutlineShrink /> : <AiOutlineExpandAlt />}</Open>}
      </Bar>
      <Chart ref={ref}>
        <canvas {...canvas} data-testid='clip-preview' />
        <canvas {...playhead} />
        {clip.notes.length === 0 && <Empty>{passive ? 'NO NOTES' : 'CLICK TO DRAW A CLIP'}</Empty>}
      </Chart>
    </Root>
  );
};
