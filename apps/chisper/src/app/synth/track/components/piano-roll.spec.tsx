import React from 'react';
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import toast from 'react-hot-toast';
import hexToRgba from 'hex-to-rgba';
import { CLIP_BAR, CLIP_PITCH_MIN, CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';
import { cssColor, drawn, switchKeyTip, withElementSize } from '@chisper/ui-kit/test-utils';
import { songFile } from '../../../../test-utils/midi-file';
import { createSynth, createTrack, stopModels } from '../../../../test-utils/models';
import { InputControllerContext, NoteOff, NoteOn } from '../../common/modules/input-controller';
import { TransportContext } from '../../common/modules/transport';
import { noteToString, stringToNote } from '../../services';
import { TRACK_LEAD, TrackContext } from '../modules/track';
import { ROLL_COLORS } from '../roll-draw';
import { laneY } from '../roll-view';
import { writeMidiFile } from '../midi-file';
import { saveClip, updateClip } from '../services/clips-api';
import { setClipEditToken } from '../services/clip-edit-tokens';
import { ClipPreview } from './clip-preview';
import { KEYS } from './roll-shortcuts';
import { RollWindow } from './roll-window';

jest.mock('../services/clips-api', () => ({
  fetchClip: jest.fn(() => Promise.reject(new Error('none'))),
  saveClip: jest.fn(),
  updateClip: jest.fn(),
}));

// the grid, the keys, the lanes: each 1000 × 420 px (jsdom has no layout: every element gets the size, the boxes
// are at 0, a point is its client coordinates). The view opens with 3.5 bars across (Fit: the loop and a bar after it
// across; all the bars of the roll in 96% of the width, 5 at least: workspaceLength), rows of 14 px, the top row 15
// rows over the middle of the notes (C4 without notes; the rows end at C0 at most): pitch p at y = (top − p) · 14
const WIDTH = 1000;
const HEIGHT = 420;
const OPEN_SCALE = WIDTH / (3.5 * CLIP_BAR);
const scaleOf = (bars: number) => (WIDTH * 0.96) / (bars * CLIP_BAR);
// px a tick of the view as it is (as it opens; `fitLoop` sets it)
let SCALE = OPEN_SCALE;
const xOf = (tick: number) => tick * SCALE;
const rowsOf = (notes: ClipNote[]) => {
  const pitches = notes.map(([, , pitch]) => pitch);
  const middle = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
  // (the rows under it end at C0)
  const top = Math.max(CLIP_PITCH_MIN + HEIGHT / 14 - 1, Math.round(middle + HEIGHT / 14 / 2));
  return (pitch: number) => (top - pitch) * 14 + 7;
};
let yOf = rowsOf([]);

// jsdom has no PointerEvent: a mouse event with a pointer id, React reads both alike; a button held from the press
// on (a move without one: its release was lost)
const pointer = (type: string, target: Element, init: MouseEventInit = {}) =>
  act(() => {
    const buttons = type === 'pointerdown' || type === 'pointermove' ? 1 : 0;
    target.dispatchEvent(
      Object.assign(new MouseEvent(type, { bubbles: true, button: 0, buttons, ...init }), { pointerId: 1 })
    );
  });
const dragOn = (target: Element, from: [number, number], to: [number, number], init: MouseEventInit = {}) => {
  pointer('pointerdown', target, { clientX: from[0], clientY: from[1], ...init });
  pointer('pointermove', target, { clientX: to[0], clientY: to[1], ...init });
  pointer('pointerup', target, { clientX: to[0], clientY: to[1], ...init });
};

// fitted by its key: the loop of the clip and a bar after it across (the rows to the middle of the notes as they are)
const fitLoop = ({ $clip }: { $clip: { value: { length: number } } }) => {
  fireEvent.click(screen.getByRole('button', { name: 'Fit the bars' }));
  SCALE = WIDTH / ($clip.value.length + CLIP_BAR);
};

// the window of the view on the overview of the bars (1000 px: the bars in 96% of it): its x and width
const overviewWindowOf = () => {
  const canvas = screen.getByTestId('roll-overview-window');
  const fill = hexToRgba(theme.colors.white, 0.1);
  const [x, , width] = drawn(canvas).find(({ style }) => style === fill)?.rects[0] ?? [];
  return [x, width];
};

let restoreSize: () => unknown = () => undefined;

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve)));

// the roll opens in draw mode: the specs of selecting and dragging switch to select mode by its key first
const setup = async (
  notes: ClipNote[] = [],
  presetId: () => string | null = () => null,
  { draw = false }: { draw?: boolean } = {}
) => {
  restoreSize = withElementSize(WIDTH, HEIGHT);
  yOf = rowsOf(notes);
  const modules = createSynth();
  await flush();
  const { track } = createTrack(modules);
  const [model, actions] = track;
  if (notes.length) actions.setNotes(notes);
  SCALE = OPEN_SCALE;
  const played: string[] = [];
  const [{ $onPress, $onRelease }] = modules.inputController;
  const label = (kind: string, { note, source }: NoteOn | NoteOff) =>
    `${kind} ${noteToString(note)} ${source}`;
  $onPress.subscribe((event) => played.push(label('on', event)));
  $onRelease.subscribe((event) => played.push(label('off', event)));
  render(
    <InputControllerContext.Provider value={modules.inputController}>
      <TransportContext.Provider value={modules.transport}>
        <TrackContext.Provider value={track}>
          <RollWindow bottom={101} presetId={presetId} />
          <ClipPreview />
        </TrackContext.Provider>
      </TransportContext.Provider>
    </InputControllerContext.Provider>
  );
  const grid = screen.getByTestId('roll-grid');
  const roll = screen.getByTestId('piano-roll');
  if (!draw) fireEvent.click(screen.getByRole('button', { name: 'Select notes' }));
  return { modules, track, model, actions, grid, roll, played };
};

afterEach(() => {
  jest.useRealTimers();
  restoreSize();
  stopModels();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  jest.clearAllMocks();
});

const SIXTEENTH = CLIP_PPQ / 4;

describe('PianoRoll', () => {
  it('adds a note a step of the grid long on a double click, takes it away on another one', async () => {
    const { model, grid } = await setup();
    // within the 6th sixteenth, row of C4
    fireEvent.doubleClick(grid, { clientX: xOf(5 * SIXTEENTH + 30), clientY: yOf(60) });
    expect(model.$clip.value.notes).toEqual([[5 * SIXTEENTH, SIXTEENTH, 60, 100]]);
    fireEvent.doubleClick(grid, { clientX: xOf(5 * SIXTEENTH + 100), clientY: yOf(60) });
    expect(model.$clip.value.notes).toEqual([]);
  });

  it('adds no note under C0, drags none there', async () => {
    const { model, grid } = await setup([[0, CLIP_PPQ, 14, 100]]);
    fireEvent.doubleClick(grid, { clientX: xOf(CLIP_BAR + 10), clientY: yOf(11) });
    expect(model.$clip.value.notes).toHaveLength(1);
    dragOn(grid, [xOf(100), yOf(14)], [xOf(100), yOf(5)]);
    expect(model.$clip.value.notes).toEqual([[0, CLIP_PPQ, 12, 100]]);
  });

  it('adds a note off the grid with Alt, none past the bars of the roll', async () => {
    const { model, grid } = await setup();
    fireEvent.doubleClick(grid, { clientX: xOf(1000), clientY: yOf(60), altKey: true });
    expect(model.$clip.value.notes[0][0]).toBeCloseTo(1000, -1);
    fireEvent.doubleClick(grid, { clientX: xOf(5 * CLIP_BAR + 100), clientY: yOf(60) });
    expect(model.$clip.value.notes).toHaveLength(1);
  });

  it('opens with 3.5 bars across, its loop of 4 bars past them (the flag in the overview)', async () => {
    const { model, grid } = await setup();
    expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
    // the right edge: in the middle of bar 4
    fireEvent.doubleClick(grid, { clientX: WIDTH - 1, clientY: yOf(60) });
    expect(model.$clip.value.notes[0][0]).toBe(Math.floor((3.5 * CLIP_BAR) / SIXTEENTH - 1) * SIXTEENTH);
    expect(screen.queryByRole('slider', { name: 'The end of the loop' })).toBeNull();
  });

  it('shows 5 bars, 2 more once a note is in the 4th: the roll stays, the overview shows them; the loop follows', async () => {
    const { model, grid } = await setup();
    // 5 bars across: all of them
    fitLoop(model);
    expect(overviewWindowOf()[1]).toBeCloseTo(960, 6);
    fireEvent.doubleClick(grid, { clientX: xOf(2 * CLIP_BAR + 10), clientY: yOf(60) });
    expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
    fireEvent.doubleClick(grid, { clientX: xOf(3 * CLIP_BAR + 10), clientY: yOf(60) });
    expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
    // 7 bars: the window of the view on the overview 5 of them, from the start
    const [x, width] = overviewWindowOf();
    expect(x).toBe(0);
    expect(width).toBeCloseTo((5 / (7 / 0.96)) * 1000, 6);
    // the roll as it was: the 5th bar where it is; the loop to its end, by the end of the loop at the edge
    fireEvent.doubleClick(grid, { clientX: xOf(4 * CLIP_BAR + 10), clientY: yOf(62) });
    expect(model.$clip.value.notes.at(-1)?.[0]).toBe(4 * CLIP_BAR);
    expect(model.$clip.value.length).toBe(5 * CLIP_BAR);
    // taken away: 4 bars of 7 (a note in the 4th), then of 5: all of them across again
    fireEvent.doubleClick(grid, { clientX: xOf(4 * CLIP_BAR + 100), clientY: yOf(62) });
    expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
    fireEvent.doubleClick(grid, { clientX: xOf(3 * CLIP_BAR + 100), clientY: yOf(60) });
    expect(overviewWindowOf()[1]).toBeCloseTo(960, 6);
    fireEvent.doubleClick(grid, { clientX: xOf(2 * CLIP_BAR + 100), clientY: yOf(60) });
    expect(model.$clip.value).toMatchObject({ length: 4 * CLIP_BAR, notes: [] });
  });

  it('fits the loop and a bar after it across by Fit and Shift+F: the end of the loop a bar from the right edge', async () => {
    const { model, grid, roll } = await setup([[3 * CLIP_BAR, SIXTEENTH, 60, 100]]);
    // a loop of 4 bars in 7 bars of the roll
    expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
    fireEvent.keyDown(roll, { key: 'F', shiftKey: true });
    // the right edge: the end of bar 5
    fireEvent.doubleClick(grid, { clientX: WIDTH - 1, clientY: yOf(62) });
    expect(model.$clip.value.notes.at(-1)).toEqual([5 * CLIP_BAR - SIXTEENTH, SIXTEENTH, 62, 100]);
    // the loop to the end of that bar; set to 2 bars by its flag (the notes past it go): 3 bars across
    expect(model.$clip.value.length).toBe(5 * CLIP_BAR);
    const flag = screen.getByRole('slider', { name: 'The end of the loop' });
    [0, 1, 2].forEach(() => fireEvent.keyDown(flag, { key: 'ArrowLeft' }));
    expect(model.$clip.value.length).toBe(2 * CLIP_BAR);
    fireEvent.click(screen.getByRole('button', { name: 'Fit the bars' }));
    fireEvent.doubleClick(grid, { clientX: WIDTH - 1, clientY: yOf(62) });
    expect(model.$clip.value.notes.at(-1)?.[0]).toBe(3 * CLIP_BAR - SIXTEENTH);
  });

  it('holds the bars while a note is dragged: the view stays under the pointer, the bars grow once let go', async () => {
    const { model, grid } = await setup([[0, CLIP_PPQ, 60, 100]]);
    fitLoop(model);
    pointer('pointerdown', grid, { clientX: xOf(100), clientY: yOf(60) });
    pointer('pointermove', grid, { clientX: xOf(3 * CLIP_BAR + 100), clientY: yOf(60) });
    expect(model.$clip.value.notes).toEqual([[3 * CLIP_BAR, CLIP_PPQ, 60, 100]]);
    // still 5 bars across: the same x is the same tick
    pointer('pointermove', grid, { clientX: xOf(3 * CLIP_BAR + 2 * CLIP_PPQ + 100), clientY: yOf(60) });
    expect(model.$clip.value.notes[0][0]).toBe(3 * CLIP_BAR + 2 * CLIP_PPQ);
    expect(overviewWindowOf()[1]).toBeCloseTo(960, 6);
    pointer('pointerup', grid, { clientX: xOf(3 * CLIP_BAR + 2 * CLIP_PPQ + 100), clientY: yOf(60) });
    // let go: 7 bars on the overview, the roll as it was
    expect(overviewWindowOf()[1]).toBeCloseTo((5 / (7 / 0.96)) * 1000, 6);
    fireEvent.doubleClick(grid, { clientX: xOf(4 * CLIP_BAR + 10), clientY: yOf(64) });
    expect(model.$clip.value.notes.at(-1)?.[0]).toBe(4 * CLIP_BAR);
  });

  it('drags a note along the grid and over the pitches: one step of the undo', async () => {
    const { model, actions, grid } = await setup([[0, CLIP_PPQ, 60, 100]]);
    const before = model.$history.value.past.length;
    pointer('pointerdown', grid, { clientX: xOf(100), clientY: yOf(60) });
    pointer('pointermove', grid, { clientX: xOf(100 + CLIP_PPQ + 50), clientY: yOf(62) });
    pointer('pointermove', grid, { clientX: xOf(100 + 2 * CLIP_PPQ + 50), clientY: yOf(64) });
    pointer('pointerup', grid, { clientX: xOf(100 + 2 * CLIP_PPQ + 50), clientY: yOf(64) });
    expect(model.$clip.value.notes).toEqual([[2 * CLIP_PPQ, CLIP_PPQ, 64, 100]]);
    expect(model.$history.value.past.length).toBe(before + 1);
    act(() => actions.undo());
    expect(model.$clip.value.notes).toEqual([[0, CLIP_PPQ, 60, 100]]);
  });

  it('resizes a note by its right edge, to the grid', async () => {
    const { model, grid } = await setup([[0, CLIP_PPQ, 60, 100]]);
    dragOn(grid, [xOf(CLIP_PPQ) - 2, yOf(60)], [xOf(2 * CLIP_PPQ + 20), yOf(60)]);
    expect(model.$clip.value.notes).toEqual([[0, 2 * CLIP_PPQ, 60, 100]]);
  });

  it('selects the notes a rectangle touches, Delete takes them away', async () => {
    const { model, grid, roll } = await setup([
      [0, SIXTEENTH, 60, 100],
      [CLIP_PPQ, SIXTEENTH, 62, 100],
      [2 * CLIP_BAR, SIXTEENTH, 72, 100],
    ]);
    dragOn(grid, [xOf(CLIP_PPQ * 3), yOf(58)], [1, yOf(64)]);
    fireEvent.keyDown(roll, { key: 'Delete' });
    expect(model.$clip.value.notes).toEqual([[2 * CLIP_BAR, SIXTEENTH, 72, 100]]);
  });

  it('a click selects a note, Shift adds one; the arrows move them', async () => {
    const { model, grid, roll } = await setup([
      [0, SIXTEENTH, 60, 100],
      [CLIP_PPQ, SIXTEENTH, 62, 100],
    ]);
    dragOn(grid, [xOf(10), yOf(60)], [xOf(10), yOf(60)]);
    dragOn(grid, [xOf(CLIP_PPQ + 10), yOf(62)], [xOf(CLIP_PPQ + 10), yOf(62)], { shiftKey: true });
    fireEvent.keyDown(roll, { key: 'ArrowUp' });
    expect(model.$clip.value.notes.map(([, , pitch]) => pitch)).toEqual([61, 63]);
    fireEvent.keyDown(roll, { key: 'ArrowDown', shiftKey: true });
    expect(model.$clip.value.notes.map(([, , pitch]) => pitch)).toEqual([49, 51]);
    fireEvent.keyDown(roll, { key: 'ArrowRight' });
    expect(model.$clip.value.notes.map(([start]) => start)).toEqual([SIXTEENTH, CLIP_PPQ + SIXTEENTH]);
    fireEvent.keyDown(roll, { key: 'ArrowRight', shiftKey: true });
    expect(model.$clip.value.notes.map(([, duration]) => duration)).toEqual([2 * SIXTEENTH, 2 * SIXTEENTH]);
  });

  it('takes the arrows without a selection too: the octave of the computer keyboard stays', async () => {
    const { roll } = await setup();
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    act(() => {
      roll.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it('takes Cmd/Ctrl with A, C, V, D, Z: select all, copy, paste, duplicate, undo and redo', async () => {
    const { model, grid, roll } = await setup([[0, SIXTEENTH, 60, 100]]);
    fireEvent.keyDown(roll, { key: 'a', metaKey: true });
    fireEvent.keyDown(roll, { key: 'd', metaKey: true });
    expect(model.$clip.value.notes).toEqual([
      [0, SIXTEENTH, 60, 100],
      [SIXTEENTH, SIXTEENTH, 60, 100],
    ]);
    fireEvent.keyDown(roll, { key: 'z', ctrlKey: true });
    expect(model.$clip.value.notes).toHaveLength(1);
    fireEvent.keyDown(roll, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(model.$clip.value.notes).toHaveLength(2);
    fireEvent.keyDown(roll, { key: 'a', metaKey: true });
    fireEvent.keyDown(roll, { key: 'c', metaKey: true });
    // pasted where the pointer was, on the grid
    pointer('pointermove', grid, { clientX: xOf(CLIP_BAR + 10), clientY: yOf(60) });
    fireEvent.keyDown(roll, { key: 'v', metaKey: true });
    expect(model.$clip.value.notes.map(([start]) => start)).toEqual([
      0,
      SIXTEENTH,
      CLIP_BAR,
      CLIP_BAR + SIXTEENTH,
    ]);
  });

  it('quantizes by Shift+Q (Q is a note of the computer keyboard; Cmd+Q quits the browser), makes legato', async () => {
    const { model, roll } = await setup([
      [10, 100, 60, 100],
      [CLIP_PPQ + 30, 100, 62, 100],
    ]);
    const notes = model.$clip.value.notes;
    // the keys the document hears (the notes of the computer keyboard)
    const heard = jest.fn();
    document.addEventListener('keydown', heard);
    const quit = createEvent.keyDown(roll, { key: 'q', code: 'KeyQ', metaKey: true });
    fireEvent(roll, quit);
    expect(quit.defaultPrevented).toBe(false);
    expect(model.$clip.value.notes).toBe(notes);
    heard.mockClear();
    const key = createEvent.keyDown(roll, { key: 'Q', code: 'KeyQ', shiftKey: true });
    fireEvent(roll, key);
    expect(key.defaultPrevented).toBe(true);
    expect(heard).not.toHaveBeenCalled();
    document.removeEventListener('keydown', heard);
    expect(model.$clip.value.notes).toEqual([
      [0, SIXTEENTH, 60, 100],
      [CLIP_PPQ, SIXTEENTH, 62, 100],
    ]);
    fireEvent.keyDown(roll, { key: 'l', ctrlKey: true });
    // the last one to the end of the loop: 4 bars
    expect(model.$clip.value.notes.map(([, duration]) => duration)).toEqual([
      CLIP_PPQ,
      4 * CLIP_BAR - CLIP_PPQ,
    ]);
  });

  it('plays the note of a key it is pressed on, as a note of the roll', async () => {
    const { played } = await setup();
    const keys = screen.getByTestId('roll-keys');
    pointer('pointerdown', keys, { clientX: 10, clientY: yOf(60) });
    pointer('pointerup', keys, { clientX: 10, clientY: yOf(60) });
    expect(played).toEqual(['on C4 roll', 'off C4 roll']);
  });

  it('plays a note it draws, the sound of the edits on by default; off, silent', async () => {
    const { played, grid } = await setup([], undefined, { draw: true });
    const sound = screen.getByRole('button', { name: 'Sound of the edits' });
    expect(sound.getAttribute('aria-pressed')).toBe('true');
    dragOn(grid, [xOf(10), yOf(60)], [xOf(10), yOf(60)]);
    expect(played).toEqual(['on C4 roll']);
    fireEvent.click(sound);
    expect(sound.getAttribute('aria-pressed')).toBe('false');
    dragOn(grid, [xOf(CLIP_BAR + 10), yOf(62)], [xOf(CLIP_BAR + 10), yOf(62)]);
    expect(played.filter((event) => event.startsWith('on'))).toEqual(['on C4 roll']);
  });

  it('plays each new pitch of a note dragged over the rows at its velocity, the one before released', async () => {
    const { played, grid, modules } = await setup([[0, CLIP_PPQ, 60, 90]]);
    const velocities: number[] = [];
    modules.inputController[0].$onPress.subscribe(({ velocity }) => velocities.push(velocity));
    jest.useFakeTimers();
    // pressed: selected, it plays
    pointer('pointerdown', grid, { clientX: xOf(100), clientY: yOf(60) });
    pointer('pointermove', grid, { clientX: xOf(100), clientY: yOf(61) });
    // along its row: no new pitch
    pointer('pointermove', grid, { clientX: xOf(CLIP_PPQ + 100), clientY: yOf(61) });
    // two rows on at once: the one it lands on
    pointer('pointermove', grid, { clientX: xOf(CLIP_PPQ + 100), clientY: yOf(63) });
    pointer('pointermove', grid, { clientX: xOf(100), clientY: yOf(60) });
    pointer('pointerup', grid, { clientX: xOf(100), clientY: yOf(60) });
    act(() => jest.advanceTimersByTime(250));
    expect(played).toEqual([
      'on C4 roll',
      'off C4 roll',
      'on C#4 roll',
      'off C#4 roll',
      'on D#4 roll',
      'off D#4 roll',
      'on C4 roll',
      'off C4 roll',
    ]);
    expect(velocities).toEqual([90, 90, 90, 90]);
  });

  it('plays the pitch of the note under the pointer as the selected ones move; off, silent', async () => {
    const { played, grid } = await setup([
      [0, CLIP_PPQ, 60, 100],
      [CLIP_PPQ, CLIP_PPQ, 64, 100],
    ]);
    const ons = () => played.filter((event) => event.startsWith('on'));
    // both selected (Shift adds the second: no sound), the second dragged a row up
    dragOn(grid, [xOf(100), yOf(60)], [xOf(100), yOf(60)]);
    dragOn(grid, [xOf(CLIP_PPQ + 100), yOf(64)], [xOf(CLIP_PPQ + 100), yOf(64)], { shiftKey: true });
    dragOn(grid, [xOf(CLIP_PPQ + 100), yOf(64)], [xOf(CLIP_PPQ + 100), yOf(65)]);
    expect(ons()).toEqual(['on C4 roll', 'on F4 roll']);
    // the sound of the edits off: dragged, silent
    fireEvent.click(screen.getByRole('button', { name: 'Sound of the edits' }));
    dragOn(grid, [xOf(100), yOf(61)], [xOf(100), yOf(58)]);
    expect(ons()).toEqual(['on C4 roll', 'on F4 roll']);
  });

  it('plays no new pitch where the selected notes can go no higher', async () => {
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 60, 100],
      [CLIP_PPQ, CLIP_PPQ, 127, 100],
    ];
    const { played, model, grid } = await setup(notes);
    const ons = () => played.filter((event) => event.startsWith('on'));
    dragOn(grid, [xOf(100), yOf(60)], [xOf(100), yOf(60)]);
    dragOn(grid, [xOf(CLIP_PPQ + 100), yOf(127)], [xOf(CLIP_PPQ + 100), yOf(127)], { shiftKey: true });
    // the first one dragged up: the top one holds both
    dragOn(grid, [xOf(100), yOf(60)], [xOf(100), yOf(62)]);
    expect(model.$clip.value.notes).toEqual(notes);
    expect(ons()).toEqual(['on C4 roll']);
    dragOn(grid, [xOf(100), yOf(60)], [xOf(100), yOf(59)]);
    expect(ons()).toEqual(['on C4 roll', 'on B3 roll']);
  });

  it('sets the velocity of a note by its bar under the roll, of the selected ones together', async () => {
    const { model } = await setup([
      [0, SIXTEENTH, 60, 100],
      [CLIP_PPQ, SIXTEENTH, 62, 100],
    ]);
    const lane = screen.getByTestId('roll-velocity');
    // a quarter of the height from the top (the dots within it): about 3/4 of 127
    dragOn(lane, [xOf(CLIP_PPQ) + 1, 50], [xOf(CLIP_PPQ) + 1, HEIGHT / 4]);
    expect(model.$clip.value.notes.map(([, , , velocity]) => velocity)).toEqual([100, 96]);
  });

  it('moves the velocities of a stem together (a chord: they keep their differences), by a selected note those only', async () => {
    const { model, roll, grid } = await setup([
      [0, SIXTEENTH, 60, 100],
      [0, SIXTEENTH, 64, 70],
      [0, SIXTEENTH, 67, 40],
      [CLIP_PPQ, SIXTEENTH, 62, 90],
    ]);
    const lane = screen.getByTestId('roll-velocity');
    const velocities = () => model.$clip.value.notes.map(([, , , velocity]) => velocity);
    // the head at 100 taken to 110: the others 10 up too
    dragOn(lane, [xOf(0) + 1, laneY(HEIGHT, 100)], [xOf(0) + 1, laneY(HEIGHT, 110)]);
    expect(velocities()).toEqual([110, 80, 50, 90]);
    // the lane selects none
    expect(screen.getByLabelText('Notes').textContent).toBe('4');
    // a note of the chord selected in the roll: it alone, taken by the heads (a few px right of the stem)
    dragOn(grid, [xOf(10), yOf(64)], [xOf(10), yOf(64)]);
    expect(screen.getByLabelText('Notes').textContent).toBe('1/4');
    pointer('pointermove', lane, { clientX: xOf(0) + 8, clientY: laneY(HEIGHT, 110) });
    expect(lane.style.cursor).toBe('ns-resize');
    dragOn(lane, [xOf(0) + 8, laneY(HEIGHT, 110)], [xOf(0) + 8, laneY(HEIGHT, 60)]);
    expect(velocities()).toEqual([110, 60, 50, 90]);
    expect(screen.getByLabelText('Notes').textContent).toBe('1/4');
    // between the stems: paints
    pointer('pointermove', lane, { clientX: xOf(CLIP_PPQ / 2), clientY: laneY(HEIGHT, 50) });
    expect(lane.style.cursor).toBe('crosshair');
    // all of them selected: the selected ones together, those of other stems too, by the head nearest the press
    fireEvent.keyDown(roll, { key: 'a', metaKey: true });
    dragOn(lane, [xOf(0) + 1, laneY(HEIGHT, 110)], [xOf(0) + 1, laneY(HEIGHT, 90)]);
    expect(velocities()).toEqual([90, 40, 30, 70]);
    // past the least: each at it, their differences back within the drag
    pointer('pointerdown', lane, { clientX: xOf(0) + 1, clientY: laneY(HEIGHT, 30) });
    pointer('pointermove', lane, { clientX: xOf(0) + 1, clientY: HEIGHT + 2000 });
    expect(velocities()).toEqual([61, 11, 1, 41]);
    pointer('pointermove', lane, { clientX: xOf(0) + 1, clientY: laneY(HEIGHT, 30) });
    pointer('pointerup', lane, { clientX: xOf(0) + 1, clientY: laneY(HEIGHT, 30) });
    expect(velocities()).toEqual([90, 40, 30, 70]);
  });

  it('takes the selected note by its stem or head, not a stem beside it nor the notes there', async () => {
    // a 32nd apart (9 px): the heads of the first over the stem of the second
    const { model, grid } = await setup([
      [0, SIXTEENTH, 60, 100],
      [0, SIXTEENTH, 64, 100],
      [CLIP_PPQ / 8, SIXTEENTH, 62, 100],
    ]);
    const lane = screen.getByTestId('roll-velocity');
    const velocities = () => model.$clip.value.notes.map(([, , , velocity]) => velocity);
    dragOn(grid, [xOf(10), yOf(60)], [xOf(10), yOf(60)]);
    expect(screen.getByLabelText('Notes').textContent).toBe('1/3');
    // on the head of the first, nearer the stem of the second
    dragOn(lane, [xOf(0) + 10, laneY(HEIGHT, 100)], [xOf(0) + 10, laneY(HEIGHT, 40)]);
    expect(velocities()).toEqual([40, 100, 100]);
    // none selected: the stem nearest, all of its notes
    fireEvent.keyDown(screen.getByTestId('piano-roll'), { key: 'Escape' });
    dragOn(lane, [xOf(0) + 10, laneY(HEIGHT, 100)], [xOf(0) + 10, laneY(HEIGHT, 70)]);
    expect(velocities()).toEqual([40, 100, 70]);
  });

  it('keeps the stem held as the hand drifts across it, painting once it leaves it: no chord set to one value', async () => {
    const { model, grid } = await setup([
      [0, SIXTEENTH, 60, 40],
      [0, SIXTEENTH, 64, 70],
      [0, SIXTEENTH, 67, 110],
      [2 * CLIP_PPQ, SIXTEENTH, 62, 90],
    ]);
    const lane = screen.getByTestId('roll-velocity');
    const velocities = () => model.$clip.value.notes.map(([, , , velocity]) => velocity);
    const y = (velocity: number) => laneY(HEIGHT, velocity);
    // the middle note of the chord selected, its head dragged up past the one over it, the hand drifting ±10 px
    dragOn(grid, [xOf(10), yOf(64)], [xOf(10), yOf(64)]);
    pointer('pointerdown', lane, { clientX: xOf(0) + 5, clientY: y(70) });
    [80, 95, 105, 115, 120].forEach((velocity, i) =>
      pointer('pointermove', lane, { clientX: xOf(0) + 5 + (i % 2 ? -10 : 10), clientY: y(velocity) })
    );
    expect(velocities()).toEqual([40, 120, 110, 90]);
    // away across: painted from there, the chord as it is
    pointer('pointermove', lane, { clientX: xOf(CLIP_PPQ), clientY: y(120) });
    pointer('pointermove', lane, { clientX: xOf(2 * CLIP_PPQ) + 1, clientY: y(30) });
    pointer('pointerup', lane, { clientX: xOf(2 * CLIP_PPQ) + 1, clientY: y(30) });
    expect(velocities().slice(0, 3)).toEqual([40, 120, 110]);
    expect(velocities()[3]).toBeLessThan(40);
  });

  it('keeps the note held out of the lane wherever the pointer goes across, and up and down by it in the lane', async () => {
    const { model, grid } = await setup([
      [0, SIXTEENTH, 60, 70],
      [2 * CLIP_PPQ, SIXTEENTH, 62, 90],
    ]);
    const lane = screen.getByTestId('roll-velocity');
    const corner = screen.getByLabelText('Velocity');
    const velocities = () => model.$clip.value.notes.map(([, , , velocity]) => velocity);
    const y = (velocity: number) => laneY(HEIGHT, velocity);
    const move = (x: number, clientY: number) => pointer('pointermove', lane, { clientX: x, clientY });
    dragOn(grid, [xOf(10), yOf(60)], [xOf(10), yOf(60)]);
    pointer('pointerdown', lane, { clientX: xOf(0) + 5, clientY: y(70) });
    // over the lane, 60 px across and back over the other stem
    move(xOf(0) + 5, -40);
    move(xOf(0) + 65, -60);
    move(xOf(2 * CLIP_PPQ) + 1, -80);
    expect(velocities()).toEqual([127, 90]);
    // back in the lane away from the stem: up and down, a bit across, it follows
    move(xOf(2 * CLIP_PPQ) + 1, y(60));
    move(xOf(2 * CLIP_PPQ) + 8, y(30));
    expect(corner.textContent).toBe('30');
    expect(velocities()).toEqual([30, 90]);
    // under the lane, then up in it
    move(xOf(2 * CLIP_PPQ) - 30, HEIGHT + 100);
    expect(velocities()).toEqual([1, 90]);
    move(xOf(2 * CLIP_PPQ) - 30, y(50));
    expect(velocities()).toEqual([50, 90]);
    pointer('pointerup', lane, { clientX: xOf(2 * CLIP_PPQ) - 30, clientY: y(50) });
  });

  it('holds the notes of a stem up and down past the lane; moved across, paints every note it passes', async () => {
    const { model, grid } = await setup([
      [0, SIXTEENTH, 60, 100],
      [CLIP_PPQ, SIXTEENTH, 62, 90],
      [2 * CLIP_PPQ, SIXTEENTH, 64, 80],
      [3 * CLIP_PPQ, SIXTEENTH, 65, 70],
    ]);
    const lane = screen.getByTestId('roll-velocity');
    const corner = screen.getByLabelText('Velocity');
    const velocities = () => model.$clip.value.notes.map(([, , , velocity]) => velocity);
    const y = (velocity: number) => laneY(HEIGHT, velocity);
    const before = model.$history.value.past.length;
    pointer('pointerdown', lane, { clientX: xOf(0) + 1, clientY: y(100) });
    // by its stem (a few px off it) far over the lane: the most; far under it: the least
    pointer('pointermove', lane, { clientX: xOf(0) + 6, clientY: -2000 });
    expect(corner.textContent).toBe('127');
    expect(velocities()).toEqual([127, 90, 80, 70]);
    pointer('pointermove', lane, { clientX: xOf(0) + 1, clientY: HEIGHT + 2000 });
    expect(corner.textContent).toBe('1');
    pointer('pointermove', lane, { clientX: xOf(0) + 1, clientY: y(60) });
    expect(velocities()).toEqual([60, 90, 80, 70]);
    // across: painted from there over the stems it passes (not selected), the one held keeps its value
    pointer('pointermove', lane, { clientX: xOf(2 * CLIP_PPQ) + 1, clientY: y(60) });
    pointer('pointerup', lane, { clientX: xOf(2 * CLIP_PPQ) + 1, clientY: y(60) });
    expect(velocities()).toEqual([60, 60, 60, 70]);
    expect(corner.textContent).toBe('VEL');
    expect(model.$history.value.past.length).toBe(before + 1);
    // a press between the stems paints every note it passes too, a note selected or not
    expect(screen.getByLabelText('Notes').textContent).toBe('4');
    dragOn(grid, [xOf(CLIP_PPQ + 10), yOf(62)], [xOf(CLIP_PPQ + 10), yOf(62)]);
    expect(screen.getByLabelText('Notes').textContent).toBe('1/4');
    dragOn(lane, [xOf(CLIP_PPQ / 2), y(20)], [xOf(3 * CLIP_PPQ) + 1, y(20)]);
    expect(velocities()).toEqual([60, 20, 20, 20]);
  });

  it('paints the velocities across the lane, along a line from the press with Shift: one step of the undo', async () => {
    const { model } = await setup([
      [0, SIXTEENTH, 60, 100],
      [CLIP_PPQ, SIXTEENTH, 62, 100],
      [2 * CLIP_PPQ, SIXTEENTH, 64, 100],
    ]);
    const lane = screen.getByTestId('roll-velocity');
    const corner = screen.getByLabelText('Velocity');
    const velocities = () => model.$clip.value.notes.map(([, , , velocity]) => velocity);
    const y = (velocity: number) => laneY(HEIGHT, velocity);
    const before = model.$history.value.past.length;
    // between the stems: painted from there across
    pointer('pointerdown', lane, { clientX: xOf(CLIP_PPQ / 2), clientY: y(20) });
    expect(corner.textContent).toBe('20');
    pointer('pointermove', lane, { clientX: xOf(2 * CLIP_PPQ) + 1, clientY: y(20) });
    pointer('pointerup', lane, { clientX: xOf(2 * CLIP_PPQ) + 1, clientY: y(20) });
    expect(velocities()).toEqual([100, 20, 20]);
    expect(model.$history.value.past.length).toBe(before + 1);
    expect(corner.textContent).toBe('VEL');
    // Shift: a line from the press
    dragOn(lane, [xOf(0), y(127)], [xOf(2 * CLIP_PPQ), y(1)], { shiftKey: true });
    expect(velocities()).toEqual([127, 64, 1]);
    expect(model.$history.value.past.length).toBe(before + 2);
  });

  it('drags the end of the loop by its flag, steps it a bar by the arrows', async () => {
    const { model } = await setup([[3 * CLIP_BAR, SIXTEENTH, 60, 100]]);
    // (its flag at the end of bar 4 in view)
    fitLoop(model);
    const flag = screen.getByRole('slider', { name: 'The end of the loop' });
    expect(flag.getAttribute('aria-valuenow')).toBe('4');
    dragOn(flag, [xOf(4 * CLIP_BAR) - 2, 10], [xOf(2 * CLIP_BAR + 30), 10]);
    expect(model.$clip.value.length).toBe(2 * CLIP_BAR);
    // the note past it went
    expect(model.$clip.value.notes).toEqual([]);
    fireEvent.keyDown(flag, { key: 'ArrowRight' });
    expect(model.$clip.value.length).toBe(3 * CLIP_BAR);
    fireEvent.keyDown(flag, { key: 'ArrowLeft' });
    expect(model.$clip.value.length).toBe(2 * CLIP_BAR);
  });

  it('keeps the flag of the end of the loop on the screen: dragged past an edge, at it; no arrow out', async () => {
    // a loop of 4 bars in 7 bars of the roll, 5 across: the right edge at the end of bar 5
    const { model } = await setup([[3 * CLIP_BAR, SIXTEENTH, 60, 100]]);
    fitLoop(model);
    const flag = () => screen.getByRole('slider', { name: 'The end of the loop' });
    pointer('pointerdown', flag(), { clientX: xOf(4 * CLIP_BAR) - 2, clientY: 10 });
    pointer('pointermove', flag(), { clientX: WIDTH + 300, clientY: 10 });
    expect(flag().style.left).toBe(`${WIDTH}px`);
    pointer('pointerup', flag(), { clientX: WIDTH + 600, clientY: 10 });
    expect(model.$clip.value.length).toBe(5 * CLIP_BAR);
    fireEvent.keyDown(flag(), { key: 'ArrowRight' });
    expect(model.$clip.value.length).toBe(5 * CLIP_BAR);
    // past the left edge: a beat
    dragOn(flag(), [WIDTH - 2, 10], [-200, 10]);
    expect(model.$clip.value.length).toBe(CLIP_PPQ);
  });

  it('plays from the bar of the ruler pressed', async () => {
    const { model, modules } = await setup([
      [0, SIXTEENTH, 60, 100],
      [3 * CLIP_BAR, SIXTEENTH, 62, 100],
    ]);
    const [{ audioCtx }] = modules.synthCore;
    pointer('pointerdown', screen.getByTestId('roll-ruler'), {
      clientX: xOf(2 * CLIP_BAR + 100),
      clientY: 10,
    });
    expect(model.$armed.value).toBe(true);
    expect(modules.transport[0].beatAt(audioCtx.currentTime + TRACK_LEAD)).toBeCloseTo(8, 6);
  });

  it('draws notes by default: dragged across, a note that long, one step of the undo; a note pressed drags', async () => {
    const { model, grid } = await setup([], undefined, { draw: true });
    const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');
    expect([pressed('Draw notes'), pressed('Select notes')]).toEqual(['true', 'false']);
    expect(screen.getByTestId('roll-empty').textContent).toMatch(/Click and drag/);
    const before = model.$history.value.past.length;
    pointer('pointerdown', grid, { clientX: xOf(CLIP_PPQ + 10), clientY: yOf(60) });
    pointer('pointermove', grid, { clientX: xOf(2 * CLIP_PPQ), clientY: yOf(60) });
    pointer('pointermove', grid, { clientX: xOf(3 * CLIP_PPQ - 20), clientY: yOf(60) });
    pointer('pointerup', grid, { clientX: xOf(3 * CLIP_PPQ - 20), clientY: yOf(60) });
    expect(model.$clip.value.notes).toEqual([[CLIP_PPQ, 2 * CLIP_PPQ, 60, 100]]);
    expect(model.$history.value.past.length).toBe(before + 1);
    expect(screen.queryByTestId('roll-empty')).toBeNull();
    // a press on it selects it, dragged it moves
    dragOn(grid, [xOf(CLIP_PPQ + 100), yOf(60)], [xOf(CLIP_PPQ + 100), yOf(62)]);
    expect(model.$clip.value.notes).toEqual([[CLIP_PPQ, 2 * CLIP_PPQ, 62, 100]]);
    expect(screen.getByLabelText('Notes').textContent).toBe('1/1');
    // the right button takes it away, no menu of the browser
    dragOn(grid, [xOf(CLIP_PPQ + 100), yOf(62)], [xOf(CLIP_PPQ + 100), yOf(62)], { button: 2 });
    expect(model.$clip.value.notes).toEqual([]);
    const menu = createEvent.contextMenu(grid);
    fireEvent(grid, menu);
    expect(menu.defaultPrevented).toBe(true);
    // a click elsewhere adds one as long as the last one drawn
    dragOn(grid, [xOf(CLIP_BAR + 10), yOf(62)], [xOf(CLIP_BAR + 10), yOf(62)]);
    expect(model.$clip.value.notes).toEqual([[CLIP_BAR, 2 * CLIP_PPQ, 62, 100]]);
  });

  it('takes notes away by the right button in draw mode, dragged over them too: one step of the undo', async () => {
    const { model, grid, roll } = await setup(
      [
        [0, SIXTEENTH, 60, 100],
        [CLIP_PPQ, SIXTEENTH, 60, 100],
        [2 * CLIP_PPQ, SIXTEENTH, 62, 100],
      ],
      undefined,
      { draw: true }
    );
    pointer('pointerdown', grid, { button: 2, clientX: xOf(10), clientY: yOf(60) });
    // the cursor of taking away while the button is held
    expect(grid.style.cursor).toBe('not-allowed');
    pointer('pointermove', grid, { button: 2, clientX: xOf(CLIP_PPQ / 2), clientY: yOf(60) });
    pointer('pointermove', grid, { button: 2, clientX: xOf(CLIP_PPQ + 10), clientY: yOf(60) });
    expect(grid.style.cursor).toBe('not-allowed');
    pointer('pointerup', grid, { button: 2, clientX: xOf(CLIP_PPQ + 10), clientY: yOf(60) });
    expect(grid.style.cursor).toBe('');
    expect(model.$clip.value.notes).toEqual([[2 * CLIP_PPQ, SIXTEENTH, 62, 100]]);
    fireEvent.keyDown(roll, { key: 'z', metaKey: true });
    expect(model.$clip.value.notes).toHaveLength(3);
  });

  it('changes nothing by the right button in select mode: no note, selection, undo step or menu', async () => {
    const { model, grid } = await setup([
      [0, SIXTEENTH, 60, 100],
      [CLIP_PPQ, SIXTEENTH, 60, 100],
      [2 * CLIP_PPQ, SIXTEENTH, 62, 100],
    ]);
    // a note selected
    dragOn(grid, [xOf(2 * CLIP_PPQ + 10), yOf(62)], [xOf(2 * CLIP_PPQ + 10), yOf(62)]);
    expect(screen.getByLabelText('Notes').textContent).toBe('1/3');
    const notes = model.$clip.value.notes;
    const past = model.$history.value.past.length;
    // pressed on a note, dragged over the others and off them
    pointer('pointerdown', grid, { button: 2, clientX: xOf(10), clientY: yOf(60) });
    expect(grid.style.cursor).not.toBe('not-allowed');
    pointer('pointermove', grid, { button: 2, clientX: xOf(CLIP_PPQ + 10), clientY: yOf(60) });
    pointer('pointermove', grid, { button: 2, clientX: xOf(2 * CLIP_PPQ + 10), clientY: yOf(62) });
    pointer('pointermove', grid, { button: 2, clientX: xOf(3 * CLIP_PPQ), clientY: yOf(64) });
    pointer('pointerup', grid, { button: 2, clientX: xOf(3 * CLIP_PPQ), clientY: yOf(64) });
    // pressed on an empty place
    dragOn(grid, [xOf(CLIP_BAR + 10), yOf(65)], [xOf(CLIP_BAR + 10), yOf(65)], { button: 2 });
    expect(model.$clip.value.notes).toBe(notes);
    expect(model.$history.value.past.length).toBe(past);
    expect(screen.getByLabelText('Notes').textContent).toBe('1/3');
    const menu = createEvent.contextMenu(grid);
    fireEvent(grid, menu);
    expect(menu.defaultPrevented).toBe(true);
  });

  it('switches between select and draw by their keys (one of them on) and by Cmd/Ctrl+B', async () => {
    const { roll } = await setup([], undefined, { draw: true });
    const pressed = () =>
      ['Select notes', 'Draw notes'].map((name) =>
        screen.getByRole('button', { name }).getAttribute('aria-pressed')
      );
    fireEvent.click(screen.getByRole('button', { name: 'Select notes' }));
    expect(pressed()).toEqual(['true', 'false']);
    expect(screen.getByTestId('roll-empty').textContent).toMatch(/Double-click/);
    // the one on pressed again stays on
    fireEvent.click(screen.getByRole('button', { name: 'Select notes' }));
    expect(pressed()).toEqual(['true', 'false']);
    fireEvent.keyDown(roll, { key: 'b', metaKey: true });
    expect(pressed()).toEqual(['false', 'true']);
    fireEvent.keyDown(roll, { key: 'b', ctrlKey: true });
    expect(pressed()).toEqual(['true', 'false']);
    fireEvent.click(screen.getByRole('button', { name: 'Draw notes' }));
    expect(pressed()).toEqual(['false', 'true']);
  });

  it('adds a note as long as the last one resized', async () => {
    const { model, grid } = await setup([[0, CLIP_PPQ, 60, 100]]);
    dragOn(grid, [xOf(CLIP_PPQ) - 2, yOf(60)], [xOf(3 * CLIP_PPQ + 20), yOf(60)]);
    fireEvent.doubleClick(grid, { clientX: xOf(CLIP_BAR + 10), clientY: yOf(64) });
    expect(model.$clip.value.notes[1]).toEqual([CLIP_BAR, 3 * CLIP_PPQ, 64, 100]);
  });

  it('shows the note a press would draw under the pointer (draw mode), its row on the grid and on its key', async () => {
    const { grid } = await setup([], undefined, { draw: true });
    const overlay = screen.getByTestId('roll-overlay');
    const lights = screen.getByTestId('roll-key-lights');
    expect(drawn(lights)).toHaveLength(0);
    pointer('pointermove', grid, { clientX: xOf(CLIP_PPQ + 30), clientY: yOf(60) });
    const [row, ghost] = drawn(overlay);
    expect(row.rects).toEqual([[0, yOf(60) - 7, WIDTH, 14]]);
    expect(ghost.rects[0][0]).toBeCloseTo(xOf(CLIP_PPQ), 6);
    expect(ghost.rects[0][2]).toBeCloseTo(xOf(SIXTEENTH) - 1, 6);
    expect(drawn(lights).map(({ rects: [[, y]] }) => y)).toEqual([yOf(60) - 7 + 0.5]);
    // select mode: it draws nothing, the row only (at once, and as the pointer moves)
    fireEvent.click(screen.getByRole('button', { name: 'Select notes' }));
    expect(drawn(overlay).map(({ rects }) => rects)).toEqual([[[0, yOf(60) - 7, WIDTH, 14]]]);
    pointer('pointermove', grid, { clientX: xOf(CLIP_PPQ + 60), clientY: yOf(62) });
    expect(drawn(overlay).map(({ rects }) => rects)).toEqual([[[0, yOf(62) - 7, WIDTH, 14]]]);
  });

  it('lights the keys of the notes the track plays', async () => {
    const { model } = await setup();
    act(() => model.$sounding.next([62, 64]));
    const ys = drawn(screen.getByTestId('roll-key-lights')).map(({ rects: [[, y]] }) => y);
    expect(ys).toEqual([yOf(62) - 7 + 0.5, yOf(64) - 7 + 0.5]);
  });

  it('lights the keys the keyboards hold (MIDI, the computer, the piano, its own), over those of the track', async () => {
    const { model, modules } = await setup();
    const [, { onPress, onRelease }] = modules.inputController;
    const lights = () =>
      drawn(screen.getByTestId('roll-key-lights')).map(({ style, rects: [[, y]] }) => [style, y]);
    act(() => model.$sounding.next([64]));
    act(() => onPress([4, 'C'], 90, { source: 'midi' }));
    act(() => onPress([4, 'E'], 100, { source: 'keys' }));
    const sounding = hexToRgba(ROLL_COLORS.sounding, 0.75);
    expect(lights()).toEqual([
      [sounding, yOf(64) - 7 + 0.5],
      [ROLL_COLORS.pressed, yOf(60) - 7 + 0.5],
      [ROLL_COLORS.pressed, yOf(64) - 7 + 0.5],
    ]);
    act(() => onRelease([4, 'C'], { source: 'midi' }));
    act(() => onRelease([4, 'E'], { source: 'keys' }));
    expect(lights()).toEqual([[sounding, yOf(64) - 7 + 0.5]]);
    // a key of the roll pressed
    const keys = screen.getByTestId('roll-keys');
    pointer('pointerdown', keys, { clientX: 10, clientY: yOf(62) });
    expect(lights()).toContainEqual([ROLL_COLORS.pressed, yOf(62) - 7 + 0.5]);
    pointer('pointerup', keys, { clientX: 10, clientY: yOf(62) });
    expect(lights()).toEqual([[sounding, yOf(64) - 7 + 0.5]]);
  });

  it('zooms by + and −; the overview over the roll scrolls the view, its edges zoom it', async () => {
    const { model, grid, roll } = await setup();
    const overview = screen.getByTestId('roll-overview');
    const extent = (5 * CLIP_BAR) / 0.96;
    // a note a double click at x adds at `pitch`
    const startAt = (x: number, pitch: number) => {
      fireEvent.doubleClick(grid, { clientX: x, clientY: yOf(pitch) });
      return model.$clip.value.notes.find(([, , notePitch]) => notePitch === pitch)?.[0];
    };
    const onGrid = (tick: number) => Math.floor(tick / SIXTEENTH) * SIXTEENTH;
    fireEvent.keyDown(roll, { key: '+', shiftKey: true });
    // 1.5 times wider around the middle
    const visible = WIDTH / (1.5 * SCALE);
    expect(startAt(0, 60)).toBe(onGrid(500 / SCALE - visible / 2));
    // its window dragged (by its middle) to the end of the overview: the end of the bars in the view
    dragOn(overview, [500, 10], [WIDTH, 10]);
    expect(startAt(0, 62)).toBe(onGrid(extent - visible));
    // zoomed out: all of the bars, no further
    fireEvent.keyDown(roll, { key: '-' });
    fireEvent.keyDown(roll, { key: '-' });
    expect(startAt((CLIP_BAR + 10) * scaleOf(5), 64)).toBe(CLIP_BAR);
    // its end dragged to the middle: twice as wide
    dragOn(overview, [WIDTH - 2, 10], [WIDTH / 2, 10]);
    expect(startAt(500, 65)).toBe(onGrid(500 / (2 * scaleOf(5))));
    // its start dragged to a quarter: the end stays
    dragOn(overview, [2, 10], [WIDTH / 4, 10]);
    expect(startAt(0, 67)).toBe(onGrid(extent / 4));
    // fitted again (the rows to the middle of the notes)
    fitLoop(model);
    fireEvent.doubleClick(grid, { clientX: xOf(2 * CLIP_BAR + 10), clientY: HEIGHT / 2 });
    expect(model.$clip.value.notes.map(([start]) => start)).toContain(2 * CLIP_BAR);
  });

  it('runs a line where the output plays over the overview too', async () => {
    const { model, roll } = await setup([[0, SIXTEENTH, 60, 100]]);
    const line = screen.getByTestId('roll-overview-playhead');
    jest.spyOn(model, 'positionAt').mockReturnValue(CLIP_BAR);
    fireEvent.keyDown(roll, { key: ' ' });
    expect(model.$playing.value).toBe(true);
    // a few frames
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    // a bar of the 5 of the roll in 96% of the width
    const x = (CLIP_BAR / ((5 * CLIP_BAR) / 0.96)) * WIDTH;
    expect(drawn(line).map(({ rects: [rect] }) => rect)).toContainEqual([
      Math.round(x) - 0.5,
      0,
      1.5,
      HEIGHT,
    ]);
    fireEvent.keyDown(roll, { key: ' ' });
    expect(drawn(line)).toHaveLength(0);
  });

  it('gives a drag up by Escape, then clears the selection; counts the selected notes', async () => {
    const { model, grid, roll } = await setup([
      [0, CLIP_PPQ, 60, 100],
      [CLIP_BAR, CLIP_PPQ, 62, 100],
    ]);
    const counter = screen.getByLabelText('Notes');
    expect(counter.textContent).toBe('2');
    const history = model.$history.value;
    pointer('pointerdown', grid, { clientX: xOf(100), clientY: yOf(60) });
    pointer('pointermove', grid, { clientX: xOf(100 + CLIP_PPQ + 50), clientY: yOf(62) });
    expect(model.$clip.value.notes[0]).toEqual([CLIP_PPQ, CLIP_PPQ, 62, 100]);
    fireEvent.keyDown(roll, { key: 'Escape' });
    pointer('pointerup', grid, { clientX: xOf(100 + CLIP_PPQ + 50), clientY: yOf(62) });
    expect(model.$clip.value.notes[0]).toEqual([0, CLIP_PPQ, 60, 100]);
    expect(model.$history.value).toBe(history);
    expect(counter.textContent).toBe('1/2');
    fireEvent.keyDown(roll, { key: 'Escape' });
    expect(counter.textContent).toBe('2');
    fireEvent.keyDown(roll, { key: 'a', metaKey: true });
    expect(counter.textContent).toBe('2/2');
  });

  it('plays and stops by Space, follows the playhead by F (off by default)', async () => {
    const { model, actions, roll } = await setup();
    // (open, as the synth shows it: the track takes Space with no notes to play)
    act(() => actions.setRollOpen(true));
    fireEvent.keyDown(roll, { key: ' ' });
    expect(model.$armed.value).toBe(true);
    fireEvent.keyDown(roll, { key: ' ' });
    expect(model.$armed.value).toBe(false);
    const follow = screen.getByRole('button', { name: 'Follow the playhead' });
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(roll, { key: 'f' });
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(roll, { key: 'f' });
    expect(follow.getAttribute('aria-pressed')).toBe('false');
  });

  it('plays and stops by Space out of the roll too: once a press, not by its repeat', async () => {
    const { model, roll } = await setup([[0, SIXTEENTH, 60, 100]]);
    fireEvent.keyDown(roll, { key: ' ' });
    expect(model.$armed.value).toBe(true);
    fireEvent.keyDown(roll, { key: ' ', repeat: true });
    expect(model.$armed.value).toBe(true);
    // the focus out of the roll (the keys under it): the track takes it
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(model.$armed.value).toBe(false);
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(model.$armed.value).toBe(true);
    // the clip name keeps it
    fireEvent.keyDown(screen.getByLabelText('Clip name'), { key: ' ' });
    expect(model.$armed.value).toBe(true);
  });

  it('tells how to add notes while the clip is empty', async () => {
    await setup();
    expect(screen.getByTestId('roll-empty').textContent).toMatch(/Double-click to add a note/);
    expect(screen.getByTestId('roll-empty').textContent).toMatch(/drop a \.mid/);
  });

  it('lists its keys under ? (the key of the header too)', async () => {
    const { roll } = await setup();
    expect(screen.queryByTestId('roll-shortcuts')).toBeNull();
    fireEvent.keyDown(roll, { key: '?', shiftKey: true });
    expect(screen.getByTestId('roll-shortcuts').textContent).toMatch(/Draw or select/);
    expect(screen.getByLabelText('Shortcuts').classList.contains('open')).toBe(true);
    fireEvent.keyDown(roll, { key: 'Escape' });
    expect(screen.getByLabelText('Shortcuts').classList.contains('open')).toBe(false);
    fireEvent.click(screen.getByLabelText('Shortcuts'));
    expect(screen.getByLabelText('Shortcuts').classList.contains('open')).toBe(true);
  });

  it('takes its letters by where they are in a layout of other letters (Cyrillic)', async () => {
    const { model, roll } = await setup([[10, 100, 60, 100]]);
    const follow = screen.getByRole('button', { name: 'Follow the playhead' });
    // Shift+Й: Shift+Q
    fireEvent.keyDown(roll, { key: 'Й', code: 'KeyQ', shiftKey: true });
    expect(model.$clip.value.notes).toEqual([[0, SIXTEENTH, 60, 100]]);
    // Cmd+Я: Cmd+Z
    fireEvent.keyDown(roll, { key: 'я', code: 'KeyZ', metaKey: true });
    expect(model.$clip.value.notes).toEqual([[10, 100, 60, 100]]);
    // Cmd+Ф: Cmd+A
    fireEvent.keyDown(roll, { key: 'ф', code: 'KeyA', metaKey: true });
    expect(screen.getByLabelText('Notes').textContent).toBe('1/1');
    // А: F
    fireEvent.keyDown(roll, { key: 'а', code: 'KeyF' });
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    // Shift+К: Shift+R, not the note of R
    const rec = createEvent.keyDown(roll, { key: 'К', code: 'KeyR', shiftKey: true });
    fireEvent(roll, rec);
    expect(rec.defaultPrevented).toBe(true);
    expect(model.$recording.value).toBe(true);
    // Shift with the key of / (a comma there): ?
    fireEvent.keyDown(roll, { key: ',', code: 'Slash', shiftKey: true });
    expect(screen.getByTestId('roll-shortcuts')).toBeTruthy();
  });

  it('takes its keys wherever the focus is while it is open, but in a text field', async () => {
    const { model } = await setup([[10, 100, 60, 100]]);
    const follow = () =>
      screen.getByRole('button', { name: 'Follow the playhead' }).getAttribute('aria-pressed');
    // nothing focused (a press on the keys under it)
    fireEvent.keyDown(document.body, { key: 'a', metaKey: true });
    expect(screen.getByLabelText('Notes').textContent).toBe('1/1');
    fireEvent.keyDown(document.body, { key: 'f' });
    expect(follow()).toBe('true');
    // the Play of the preview of the clip, out of the roll
    const preview = screen.getByRole('button', { name: 'Open the piano roll' });
    const play = within(preview).getByRole('button', { name: 'Play the track' });
    fireEvent.keyDown(play, { key: 'Delete' });
    expect(model.$clip.value.notes).toEqual([]);
    fireEvent.keyDown(play, { key: 'z', metaKey: true });
    expect(model.$clip.value.notes).toEqual([[10, 100, 60, 100]]);
    // the clip name keeps them
    fireEvent.keyDown(screen.getByLabelText('Clip name'), { key: 'f' });
    expect(follow()).toBe('true');
    // closed: none of them (the redo of the Delete stays)
    cleanup();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    expect(model.$clip.value.notes).toEqual([[10, 100, 60, 100]]);
  });

  it('goes to the playhead once F turns the following on while the track plays, and as Play starts with it on', async () => {
    const { model, roll } = await setup([[0, SIXTEENTH, 60, 100]]);
    const frames = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    // the view: 3.5 bars from the start; the playhead in the 4th bar, out of it
    const position = jest.spyOn(model, 'positionAt').mockReturnValue(3.75 * CLIP_BAR);
    fireEvent.keyDown(roll, { key: ' ' });
    expect(model.$playing.value).toBe(true);
    await frames();
    expect(overviewWindowOf()[0]).toBe(0);
    fireEvent.keyDown(roll, { key: 'f' });
    await frames();
    // to its bar, as far as the bars of the roll go: the view at their end
    const [x = NaN, width = NaN] = overviewWindowOf();
    expect(x).toBeGreaterThan(0);
    expect(x + width).toBeCloseTo(WIDTH, 6);
    // stopped; Play from the start of the loop, out of the view: it goes there
    fireEvent.keyDown(roll, { key: ' ' });
    position.mockReturnValue(CLIP_BAR / 4);
    fireEvent.keyDown(roll, { key: ' ' });
    await frames();
    expect(overviewWindowOf()[0]).toBe(0);
  });

  // its pointerup lost (the button let go outside the window, while another app had the focus): a move without a
  // button or the capture lost ends a drag as a release would, nothing follows the mouse after it
  describe('a drag whose release is lost', () => {
    it('lets the window of the overview go where it was dragged, its cursor back', async () => {
      await setup();
      const overview = screen.getByTestId('roll-overview');
      const [x0 = NaN] = overviewWindowOf();
      // by its middle
      pointer('pointerdown', overview, { clientX: 300, clientY: 10 });
      expect(overview.style.cursor).toBe('grabbing');
      pointer('pointermove', overview, { clientX: 400, clientY: 10 });
      const dragged = overviewWindowOf();
      expect(dragged[0]).toBeCloseTo(x0 + 100, 6);
      pointer('pointermove', overview, { clientX: 500, clientY: 10, buttons: 0 });
      pointer('pointermove', overview, { clientX: 600, clientY: 10, buttons: 0 });
      expect(overviewWindowOf()).toEqual(dragged);
      // the cursor of where it is: in the window
      expect(overview.style.cursor).toBe('grab');
      // the capture lost: a move moves nothing either
      pointer('pointerdown', overview, { clientX: 300, clientY: 10 });
      pointer('pointermove', overview, { clientX: 250, clientY: 10 });
      const moved = overviewWindowOf();
      expect(moved[0]).toBeCloseTo(x0 + 50, 6);
      pointer('lostpointercapture', overview);
      pointer('pointermove', overview, { clientX: 100, clientY: 10 });
      expect(overviewWindowOf()).toEqual(moved);
      // cancelled: the cursor back
      pointer('pointerdown', overview, { clientX: 300, clientY: 10 });
      pointer('pointercancel', overview);
      expect(overview.style.cursor).toBe('');
    });

    it('lets a note go where it was dragged: one step of the undo, the bars grow', async () => {
      const { model, grid } = await setup([[0, CLIP_PPQ, 60, 100]]);
      fitLoop(model);
      const before = model.$history.value.past.length;
      pointer('pointerdown', grid, { clientX: xOf(100), clientY: yOf(60) });
      pointer('pointermove', grid, { clientX: xOf(3 * CLIP_BAR + 100), clientY: yOf(60) });
      expect(overviewWindowOf()[1]).toBeCloseTo(960, 6);
      pointer('pointermove', grid, { clientX: xOf(CLIP_BAR + 100), clientY: yOf(64), buttons: 0 });
      pointer('pointermove', grid, { clientX: xOf(100), clientY: yOf(60) });
      expect(model.$clip.value.notes).toEqual([[3 * CLIP_BAR, CLIP_PPQ, 60, 100]]);
      expect(model.$history.value.past.length).toBe(before + 1);
      // let go: 7 bars on the overview
      expect(overviewWindowOf()[1]).toBeCloseTo((5 / (7 / 0.96)) * 1000, 6);
    });

    it('draws a note as long as it was dragged once the capture is lost, the next ones that long', async () => {
      const { model, grid } = await setup([], undefined, { draw: true });
      const before = model.$history.value.past.length;
      pointer('pointerdown', grid, { clientX: xOf(CLIP_PPQ + 10), clientY: yOf(60) });
      pointer('pointermove', grid, { clientX: xOf(2 * CLIP_PPQ), clientY: yOf(60) });
      pointer('pointermove', grid, { clientX: xOf(3 * CLIP_PPQ - 20), clientY: yOf(60) });
      pointer('lostpointercapture', grid);
      pointer('pointermove', grid, { clientX: xOf(5 * CLIP_PPQ - 20), clientY: yOf(60) });
      expect(model.$clip.value.notes).toEqual([[CLIP_PPQ, 2 * CLIP_PPQ, 60, 100]]);
      expect(model.$history.value.past.length).toBe(before + 1);
      dragOn(grid, [xOf(CLIP_BAR + 10), yOf(62)], [xOf(CLIP_BAR + 10), yOf(62)]);
      expect(model.$clip.value.notes.at(-1)).toEqual([CLIP_BAR, 2 * CLIP_PPQ, 62, 100]);
    });

    it('sets the velocities as they were dragged: one step of the undo each, the corner back', async () => {
      const { model } = await setup([[0, SIXTEENTH, 60, 100]]);
      const lane = screen.getByTestId('roll-velocity');
      const corner = screen.getByLabelText('Velocity');
      const velocity = () => model.$clip.value.notes[0][3];
      const y = (value: number) => laneY(HEIGHT, value);
      const before = model.$history.value.past.length;
      pointer('pointerdown', lane, { clientX: xOf(0) + 1, clientY: y(100) });
      pointer('pointermove', lane, { clientX: xOf(0) + 1, clientY: y(110) });
      expect(corner.textContent).toBe('110');
      pointer('pointermove', lane, { clientX: xOf(0) + 1, clientY: y(60), buttons: 0 });
      pointer('pointermove', lane, { clientX: xOf(0) + 1, clientY: y(40) });
      expect(velocity()).toBe(110);
      expect(corner.textContent).toBe('VEL');
      expect(model.$history.value.past.length).toBe(before + 1);
      // the capture lost
      pointer('pointerdown', lane, { clientX: xOf(0) + 1, clientY: y(110) });
      pointer('pointermove', lane, { clientX: xOf(0) + 1, clientY: y(90) });
      pointer('lostpointercapture', lane);
      pointer('pointermove', lane, { clientX: xOf(0) + 1, clientY: y(50) });
      expect(velocity()).toBe(90);
      expect(corner.textContent).toBe('VEL');
      expect(model.$history.value.past.length).toBe(before + 2);
    });

    it('sets the end of the loop its flag was dragged to', async () => {
      const { model } = await setup([[3 * CLIP_BAR, SIXTEENTH, 60, 100]]);
      fitLoop(model);
      const flag = () => screen.getByRole('slider', { name: 'The end of the loop' });
      pointer('pointerdown', flag(), { clientX: xOf(4 * CLIP_BAR) - 2, clientY: 10 });
      pointer('pointermove', flag(), { clientX: xOf(3 * CLIP_BAR + 30), clientY: 10 });
      expect(flag().classList.contains('dragged')).toBe(true);
      pointer('pointermove', flag(), { clientX: xOf(CLIP_BAR + 30), clientY: 10, buttons: 0 });
      expect(model.$clip.value.length).toBe(3 * CLIP_BAR);
      expect(flag().classList.contains('dragged')).toBe(false);
      pointer('pointermove', flag(), { clientX: xOf(CLIP_BAR + 30), clientY: 10 });
      expect(flag().getAttribute('aria-valuenow')).toBe('3');
      // the capture lost
      pointer('pointerdown', flag(), { clientX: xOf(3 * CLIP_BAR) - 2, clientY: 10 });
      pointer('pointermove', flag(), { clientX: xOf(2 * CLIP_BAR + 30), clientY: 10 });
      pointer('lostpointercapture', flag());
      pointer('pointermove', flag(), { clientX: xOf(CLIP_BAR + 30), clientY: 10 });
      expect(model.$clip.value.length).toBe(2 * CLIP_BAR);
      expect(flag().classList.contains('dragged')).toBe(false);
    });

    it('releases the note of a key of the roll: a move without a button, the window left', async () => {
      const { played } = await setup();
      const keys = screen.getByTestId('roll-keys');
      pointer('pointerdown', keys, { clientX: 10, clientY: yOf(60) });
      pointer('pointermove', document.body, { clientX: 300, clientY: 10, buttons: 0 });
      expect(played).toEqual(['on C4 roll', 'off C4 roll']);
      pointer('pointerdown', keys, { clientX: 10, clientY: yOf(62) });
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(played.slice(2)).toEqual(['on D4 roll', 'off D4 roll']);
      // a press plays again
      pointer('pointerdown', keys, { clientX: 10, clientY: yOf(64) });
      pointer('pointerup', keys, { clientX: 10, clientY: yOf(64) });
      expect(played.slice(4)).toEqual(['on E4 roll', 'off E4 roll']);
    });
  });
});

describe('the tooltips of the roll', () => {
  afterEach(() => jest.useRealTimers());

  it('name the keys of the edits', async () => {
    await setup();
    jest.useFakeTimers();
    expect(switchKeyTip('Undo')).toBe(`Undo${KEYS.undo}`);
    expect(switchKeyTip('Draw notes')).toMatch(KEYS.draw);
    expect(switchKeyTip('Zoom in')).toBe(`Zoom in${KEYS.zoomIn}`);
    expect(switchKeyTip('Record')).toMatch(KEYS.record);
  });
});

describe('the toolbar of the roll', () => {
  it('records by REC and Shift+R (no note of the computer keyboard), lit red; Stop stops it with the track', async () => {
    const { model, roll } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(model.$recording.value).toBe(true);
    expect(model.$armed.value).toBe(true);
    const rec = screen.getByRole('button', { name: 'Stop recording' });
    expect(rec.getAttribute('aria-pressed')).toBe('true');
    expect(getComputedStyle(rec).color).toBe(cssColor(theme.colors.red));
    fireEvent.click(rec);
    expect(model.$recording.value).toBe(false);
    expect(model.$armed.value).toBe(true);
    // Shift+R: the roll takes it (R is a note of the computer keyboard)
    const key = createEvent.keyDown(roll, { key: 'R', shiftKey: true });
    fireEvent(roll, key);
    expect(key.defaultPrevented).toBe(true);
    expect(model.$recording.value).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop the track' }));
    expect(model.$recording.value).toBe(false);
    expect(model.$armed.value).toBe(false);
    fireEvent.keyDown(roll, { key: 'R', shiftKey: true });
    expect(model.$recording.value).toBe(true);
    fireEvent.keyDown(roll, { key: 'R', shiftKey: true });
    expect(model.$recording.value).toBe(false);
  });

  it('follows the playhead as REC goes on, and as it opens while REC records', async () => {
    const { modules, track, actions } = await setup();
    const follow = () =>
      screen.getByRole('button', { name: 'Follow the playhead' }).getAttribute('aria-pressed');
    expect(follow()).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(follow()).toBe('true');
    // off by its key: off while REC records and once it goes off; on again with REC
    fireEvent.click(screen.getByRole('button', { name: 'Follow the playhead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    expect(follow()).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(follow()).toBe('true');
    // the roll closed and opened again while REC records
    act(() => actions.stopRecording());
    cleanup();
    act(() => actions.record());
    render(
      <InputControllerContext.Provider value={modules.inputController}>
        <TransportContext.Provider value={modules.transport}>
          <TrackContext.Provider value={track}>
            <RollWindow bottom={101} presetId={() => null} />
          </TrackContext.Provider>
        </TransportContext.Provider>
      </InputControllerContext.Provider>
    );
    expect(follow()).toBe('true');
  });

  it('shows a note recorded among the notes, the selected ones still selected', async () => {
    const { modules, model, roll } = await setup([[2 * CLIP_BAR, SIXTEENTH, 72, 100]]);
    const [, { onPress, onRelease }] = modules.inputController;
    fireEvent.keyDown(roll, { key: 'a', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    // (pressed before the play starts: at its start)
    act(() => onPress(stringToNote('C4'), 90, { source: 'midi' }));
    act(() => onRelease(stringToNote('C4'), { source: 'midi' }));
    expect(model.$clip.value.notes).toEqual([
      [0, 1, 60, 90],
      [2 * CLIP_BAR, SIXTEENTH, 72, 100],
    ]);
    // the selected note: the one there before
    fireEvent.keyDown(roll, { key: 'Delete' });
    expect(model.$clip.value.notes).toEqual([[0, 1, 60, 90]]);
  });

  it('has no length: the loop of 4 bars follows the notes, its flag sets it apart', async () => {
    const { model, grid } = await setup([[0, SIXTEENTH, 60, 100]]);
    expect(screen.queryByRole('slider', { name: 'Bars' })).toBeNull();
    expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
    fitLoop(model);
    const flag = screen.getByRole('slider', { name: 'The end of the loop' });
    fireEvent.keyDown(flag, { key: 'ArrowLeft' });
    fireEvent.keyDown(flag, { key: 'ArrowLeft' });
    expect(model.$clip.value.length).toBe(2 * CLIP_BAR);
    // an edit within it keeps it
    fireEvent.doubleClick(grid, { clientX: xOf(CLIP_BAR + 10), clientY: yOf(62) });
    expect(model.$clip.value.length).toBe(2 * CLIP_BAR);
  });

  it('steps the grid from the longest step to the finest', async () => {
    const { model, grid } = await setup();
    const step = screen.getByRole('slider', { name: 'Grid' });
    expect(step.getAttribute('aria-valuetext')).toBe('1/16');
    fireEvent.keyDown(step, { key: 'ArrowDown' });
    expect(step.getAttribute('aria-valuetext')).toBe('1/8T');
    fireEvent.doubleClick(grid, { clientX: xOf(10), clientY: yOf(60) });
    expect(model.$clip.value.notes).toEqual([[0, CLIP_PPQ / 3, 60, 100]]);
  });

  it('transposes by the arrows (no keys of its own), undoes and redoes by its buttons', async () => {
    const { model, roll } = await setup([[0, SIXTEENTH, 60, 100]]);
    expect(screen.queryByLabelText('An octave up')).toBeNull();
    fireEvent.keyDown(roll, { key: 'a', metaKey: true });
    fireEvent.keyDown(roll, { key: 'ArrowUp', shiftKey: true });
    expect(model.$clip.value.notes[0][2]).toBe(72);
    fireEvent.click(screen.getByLabelText('Undo'));
    expect(model.$clip.value.notes[0][2]).toBe(60);
    fireEvent.click(screen.getByLabelText('Redo'));
    expect(model.$clip.value.notes[0][2]).toBe(72);
  });

  it('imports a .mid by its button and exports one', async () => {
    const { model } = await setup();
    const bytes = writeMidiFile({ bpm: 128, length: CLIP_BAR, notes: [[0, CLIP_PPQ, 48, 90]] });
    const file = new File([bytes], 'riff.mid', { type: 'audio/midi' });
    Object.assign(file, { arrayBuffer: () => Promise.resolve(bytes.buffer) });
    fireEvent.change(screen.getByTestId('midi-file'), { target: { files: [file] } });
    await flush();
    expect(model.$clip.value).toMatchObject({ bpm: 128, length: CLIP_BAR, notes: [[0, CLIP_PPQ, 48, 90]] });

    const createObjectURL = jest.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByLabelText('Export'));
    expect(createObjectURL).toHaveBeenCalled();
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('clip.mid');
    click.mockRestore();
  });

  describe('a .mid of several parts', () => {
    const song = songFile([
      { name: 'Lead', notes: [[0, CLIP_PPQ, 72, 100]] },
      {
        name: 'Pads',
        notes: [
          [0, CLIP_PPQ, 60, 90],
          [0, CLIP_PPQ, 64, 90],
        ],
      },
      { name: 'Kit', channel: 10, notes: [[0, SIXTEENTH, 36, 110]] },
    ]);
    const importSong = async () => {
      const file = new File([song], 'song.mid', { type: 'audio/midi' });
      Object.assign(file, { arrayBuffer: () => Promise.resolve(song.buffer) });
      fireEvent.change(screen.getByTestId('midi-file'), { target: { files: [file] } });
      await flush();
      return screen.findByRole('dialog');
    };
    const checkbox = (dialog: HTMLElement, name: RegExp) => within(dialog).getByRole('checkbox', { name });

    it('lists them by name with their channel, program, notes and range: the drums unchecked', async () => {
      const { model } = await setup([[0, SIXTEENTH, 48, 100]]);
      const dialog = await importSong();
      expect(within(dialog).getByText('The file has 3 parts: choose those to import.')).toBeTruthy();
      expect(within(dialog).getByText('Ch 1 · 1 note · C5')).toBeTruthy();
      expect(within(dialog).getByText('Ch 1 · 2 notes · C4–E4')).toBeTruthy();
      expect(within(dialog).getByText('Ch 10 · Drums · 1 note · C2')).toBeTruthy();
      expect(checkbox(dialog, /^Lead/)).toHaveProperty('checked', true);
      expect(checkbox(dialog, /^Pads/)).toHaveProperty('checked', true);
      expect(checkbox(dialog, /^Kit/)).toHaveProperty('checked', false);
      expect(checkbox(dialog, /^All$/).closest('.ant-checkbox')?.classList).toContain(
        'ant-checkbox-indeterminate'
      );
      // nothing imported yet
      expect(model.$clip.value.notes).toEqual([[0, SIXTEENTH, 48, 100]]);

      fireEvent.click(checkbox(dialog, /^Pads/));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
      expect(model.$clip.value).toMatchObject({ notes: [[0, CLIP_PPQ, 72, 100]], name: 'Lead' });
      expect(model.$midiImport.value).toBeNull();
    });

    // (jsdom takes the rule inserted last, not the most specific one: the colors of antd's own parts aren't checked)
    it('is a section of the synth: the parts on its dark screen, those left out dimmed, a count', async () => {
      await setup();
      const dialog = await importSong();
      const nameColor = (name: string) => getComputedStyle(within(dialog).getByText(name)).color;
      expect(getComputedStyle(within(dialog).getByTestId('midi-parts')).backgroundColor).toBe(
        cssColor(theme.colors.primaryDark)
      );
      expect(nameColor('Lead')).toBe(cssColor(theme.colors.white));
      expect(nameColor('Kit')).toBe(cssColor(theme.colors.primaryMediumContrast));
      expect(within(dialog).getByText('2 of 3')).toBeTruthy();

      fireEvent.click(checkbox(dialog, /^Kit/));
      expect(nameColor('Kit')).toBe(cssColor(theme.colors.white));
      expect(within(dialog).getByText('3 of 3')).toBeTruthy();
      // closed by its key in the header
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('imports all of them by All, none: Import off', async () => {
      const { model } = await setup();
      const dialog = await importSong();
      const all = checkbox(dialog, /^All$/);
      const ok = within(dialog).getByRole('button', { name: 'Import' });
      fireEvent.click(all);
      expect(checkbox(dialog, /^Kit/)).toHaveProperty('checked', true);
      fireEvent.click(all);
      expect(checkbox(dialog, /^Lead/)).toHaveProperty('checked', false);
      expect(ok).toHaveProperty('disabled', true);
      fireEvent.click(checkbox(dialog, /^Kit/));
      fireEvent.click(checkbox(dialog, /^Pads/));
      fireEvent.click(ok);
      expect(model.$clip.value.notes).toEqual([
        [0, SIXTEENTH, 36, 110],
        [0, CLIP_PPQ, 60, 90],
        [0, CLIP_PPQ, 64, 90],
      ]);
    });

    it('given up imports nothing; the keys of its dialog stay out of the roll', async () => {
      const { model, roll } = await setup([[0, SIXTEENTH, 48, 100]]);
      // selected: a Delete that reached the roll would take it away
      fireEvent.keyDown(roll, { key: 'a', metaKey: true });
      const dialog = await importSong();
      // (where antd puts the focus; the checkboxes are inputs, which the roll leaves alone anyway)
      fireEvent.keyDown(dialog, { key: ' ' });
      fireEvent.keyDown(dialog, { key: 'Delete' });
      expect(model.$playing.value).toBe(false);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(model.$midiImport.value).toBeNull();
      expect(model.$clip.value.notes).toEqual([[0, SIXTEENTH, 48, 100]]);
    });
  });

  it('names the clip and sets its tempo, the tempo of the synth', async () => {
    const { model, modules } = await setup();
    fireEvent.change(screen.getByLabelText('Clip name'), { target: { value: 'Bass' } });
    expect(model.$clip.value.name).toBe('Bass');
    // the display of the settings on the strip
    const strip = screen.getByTestId('roll-strip');
    expect(within(strip).getByRole('img', { name: '120.00' })).toBeTruthy();
    expect(within(strip).getByText('BPM')).toBeTruthy();
    fireEvent.click(within(strip).getByRole('button', { name: 'Faster' }));
    expect(modules.transport[0].$bpm.value).toBe(121);
    expect(model.$clip.value.bpm).toBe(121);
    expect(within(strip).getByRole('img', { name: '121.00' })).toBeTruthy();
    // a MIDI Clock leads the tempo: shown only, its own
    act(() => modules.transport[1].setSource('midi'));
    expect(within(strip).queryByRole('button', { name: 'Faster' })).toBeNull();
    expect(within(strip).getByText('EXT')).toBeTruthy();
  });

  it('saves a new clip after the captcha, overwrites its own clip by its token', async () => {
    const { model } = await setup([[0, SIXTEENTH, 60, 100]]);
    (saveClip as jest.Mock).mockResolvedValue({
      id: 'c1',
      existed: false,
      editToken: 'secret-token-of-the-clip',
    });
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }));
    await flush();
    expect(saveClip).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pass captcha' }));
    await flush();
    expect(saveClip).toHaveBeenCalledWith(model.$clip.value, 'captcha-token');
    expect(model.$id.value).toBe('c1');
    expect(window.location.search).toBe('?clip=c1');

    (updateClip as jest.Mock).mockResolvedValue({ id: 'c1' });
    fireEvent.change(screen.getByLabelText('Clip name'), { target: { value: 'Mine' } });
    fireEvent.doubleClick(screen.getByTestId('roll-grid'), { clientX: xOf(CLIP_BAR), clientY: yOf(64) });
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }));
    await flush();
    expect(updateClip).toHaveBeenCalledWith('c1', model.$clip.value, 'secret-token-of-the-clip');
    expect(saveClip).toHaveBeenCalledTimes(1);
  });

  it('tells of a name the server would refuse before the captcha, saves nothing', async () => {
    const { actions } = await setup([[0, SIXTEENTH, 60, 100]]);
    fireEvent.change(screen.getByLabelText('Clip name'), { target: { value: 'Sexy pad' } });
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }));
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Please choose another name');
    expect(screen.queryByRole('button', { name: 'Pass captcha' })).toBeNull();
    // its own clip: not overwritten either
    setClipEditToken('c3', 'secret-token-of-the-clip');
    actions.setSaved('c3');
    actions.setNotes([[0, SIXTEENTH, 62, 100]]);
    fireEvent.click(screen.getByRole('button', { name: /Save$/ }));
    await flush();
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(saveClip).not.toHaveBeenCalled();
    expect(updateClip).not.toHaveBeenCalled();
  });

  it('shares the link of a saved clip with the preset whose sound is unchanged', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { actions } = await setup([[0, SIXTEENTH, 60, 100]], () => 'p1');
    setClipEditToken('c2', 'secret-token-of-the-clip');
    actions.setSaved('c2');
    fireEvent.click(screen.getByRole('button', { name: /Share$/ }));
    await flush();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?preset=p1&clip=c2`);
    expect(updateClip).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it('closes the roll', async () => {
    const { model, actions } = await setup();
    actions.setRollOpen(true);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(model.$rollOpen.value).toBe(false);
  });
});

describe('ClipPreview', () => {
  it('is red while REC records, its button stops both', async () => {
    const { model, actions } = await setup();
    act(() => actions.record());
    const play = screen.getByRole('button', { name: 'Stop the track and the recording' });
    expect(play.classList.contains('rec')).toBe(true);
    fireEvent.click(play);
    expect(model.$recording.value).toBe(false);
    expect(model.$armed.value).toBe(false);
    expect(play.getAttribute('aria-label')).toBe('Play the track');
    expect(play.classList.contains('rec')).toBe(false);
  });

  it('opens and closes the roll by a click, plays and stops the track by its button', async () => {
    const { model } = await setup([[0, SIXTEENTH, 60, 100]]);
    const preview = screen.getByRole('button', { name: 'Open the piano roll' });
    fireEvent.click(preview);
    expect(model.$rollOpen.value).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close the piano roll' }));
    expect(model.$rollOpen.value).toBe(false);

    const [play] = screen.getAllByRole('button', { name: 'Play the track' });
    fireEvent.click(play);
    expect(model.$armed.value).toBe(true);
    expect(model.$rollOpen.value).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop the track' })[0]);
    expect(model.$armed.value).toBe(false);
    expect(screen.getByText('4 bars · 1 note')).toBeTruthy();
  });
});
