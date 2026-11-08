import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { CLIP_BAR, CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import { withElementSize } from '@chisper/ui-kit/test-utils';
import { createSynth, createTrack, stopModels } from '../../../../test-utils/models';
import { InputControllerContext } from '../../common/modules/input-controller';
import { TransportContext } from '../../common/modules/transport';
import { noteToString } from '../../services';
import { TRACK_LEAD, TrackContext } from '../modules/track';
import { MobileRoll } from './mobile-roll';

jest.mock('../services/clips-api', () => ({
  fetchClip: jest.fn(() => Promise.reject(new Error('none'))),
  saveClip: jest.fn(),
  updateClip: jest.fn(),
}));

// every element 1000 × 420 px at 0 (jsdom has no layout): a view fitted to a bar of the loop (a phone shows one at
// most), rows of 18 px, the top row 12 rows over the middle of the notes (C4 without notes)
const WIDTH = 1000;
const HEIGHT = 420;
const SCALE = (WIDTH * 0.96) / CLIP_BAR;
const xOf = (tick: number) => tick * SCALE;
const rowsOf = (notes: ClipNote[]) => {
  const pitches = notes.map(([, , pitch]) => pitch);
  const middle = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
  const top = Math.round(middle + Math.ceil(HEIGHT / 18) / 2);
  return (pitch: number) => (top - pitch) * 18 + 9;
};
const SIXTEENTH = CLIP_PPQ / 4;

// a finger (jsdom has no PointerEvent: a mouse event with a pointer id)
const finger = (type: string, target: Element, id: number, x: number, y: number) =>
  act(() => {
    target.dispatchEvent(
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), { pointerId: id })
    );
  });
const tap = (target: Element, x: number, y: number) => {
  finger('pointerdown', target, 1, x, y);
  finger('pointerup', target, 1, x, y);
};
const swipe = (target: Element, from: [number, number], to: [number, number]) => {
  finger('pointerdown', target, 1, ...from);
  finger('pointermove', target, 1, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  finger('pointermove', target, 1, ...to);
  finger('pointerup', target, 1, ...to);
};

let restoreSize: () => unknown = () => undefined;
afterEach(() => {
  jest.useRealTimers();
  restoreSize();
  stopModels();
  sessionStorage.clear();
});

const setup = async (notes: ClipNote[] = []) => {
  restoreSize = withElementSize(WIDTH, HEIGHT);
  const modules = createSynth();
  await act(() => new Promise((resolve) => setTimeout(resolve)));
  const { track } = createTrack(modules);
  if (notes.length) track[1].setNotes(notes);
  render(
    <InputControllerContext.Provider value={modules.inputController}>
      <TransportContext.Provider value={modules.transport}>
        <TrackContext.Provider value={track}>
          <MobileRoll presetId={() => null} />
        </TrackContext.Provider>
      </TransportContext.Provider>
    </InputControllerContext.Provider>
  );
  return { modules, model: track[0], grid: screen.getByTestId('mobile-roll-grid'), yOf: rowsOf(notes) };
};

describe('MobileRoll', () => {
  it('a tap adds a note a step of the grid long, a tap on it takes it away', async () => {
    const { model, grid, yOf } = await setup();
    tap(grid, xOf(3 * SIXTEENTH + 20), yOf(60));
    expect(model.$clip.value.notes).toEqual([[3 * SIXTEENTH, SIXTEENTH, 60, 100]]);
    tap(grid, xOf(3 * SIXTEENTH + 100), yOf(60));
    expect(model.$clip.value.notes).toEqual([]);
  });

  it('drags a note, its end resizes it: one step of the undo each', async () => {
    const { model, grid, yOf } = await setup([[0, CLIP_PPQ, 60, 100]]);
    swipe(grid, [xOf(100), yOf(60)], [xOf(100 + CLIP_PPQ + 30), yOf(62)]);
    expect(model.$clip.value.notes).toEqual([[CLIP_PPQ, CLIP_PPQ, 62, 100]]);
    swipe(grid, [xOf(2 * CLIP_PPQ) - 4, yOf(62)], [xOf(3 * CLIP_PPQ + 20), yOf(62)]);
    expect(model.$clip.value.notes).toEqual([[CLIP_PPQ, 2 * CLIP_PPQ, 62, 100]]);
    expect(model.$history.value.past).toHaveLength(3);
  });

  it('plays each new pitch of a note dragged at its velocity, the one before released; a tap on it, none', async () => {
    const { modules, model, grid, yOf } = await setup([[0, CLIP_PPQ, 60, 90]]);
    const played: string[] = [];
    const [{ $onPress, $onRelease }] = modules.inputController;
    $onPress.subscribe(({ note, velocity }) => played.push(`on ${noteToString(note)} ${velocity}`));
    $onRelease.subscribe(({ note }) => played.push(`off ${noteToString(note)}`));
    jest.useFakeTimers();
    finger('pointerdown', grid, 1, xOf(100), yOf(60));
    // past the slop along its row: no new pitch
    finger('pointermove', grid, 1, xOf(100) + 20, yOf(60));
    finger('pointermove', grid, 1, xOf(100), yOf(62));
    finger('pointermove', grid, 1, xOf(100), yOf(61));
    finger('pointerup', grid, 1, xOf(100), yOf(61));
    act(() => jest.advanceTimersByTime(250));
    expect(model.$clip.value.notes).toEqual([[0, CLIP_PPQ, 61, 90]]);
    expect(played).toEqual(['on D4 90', 'off D4', 'on C#4 90', 'off C#4']);
    tap(grid, xOf(100), yOf(61));
    expect(model.$clip.value.notes).toEqual([]);
    expect(played).toHaveLength(4);
  });

  it('a drag elsewhere scrolls: a tap after it lands a row lower', async () => {
    const { model, grid, yOf } = await setup();
    swipe(grid, [500, 200], [500, 218]);
    tap(grid, xOf(10), yOf(60));
    expect(model.$clip.value.notes[0][2]).toBe(61);
  });

  it('two fingers zoom: a step of the grid wider', async () => {
    const { model, grid, yOf } = await setup();
    finger('pointerdown', grid, 1, 100, 100);
    finger('pointerdown', grid, 2, 300, 100);
    finger('pointermove', grid, 2, 500, 100);
    finger('pointerup', grid, 2, 500, 100);
    finger('pointerup', grid, 1, 100, 100);
    // twice as wide around x 300: what was at x 300 still is
    expect(model.$clip.value.notes).toEqual([]);
    tap(grid, 300 + 2 * xOf(SIXTEENTH) * 0.5, yOf(60));
    const [[start]] = model.$clip.value.notes;
    expect(start).toBe(Math.floor((300 / SCALE + SIXTEENTH / 2) / SIXTEENTH) * SIXTEENTH);
  });

  it('adds a note as long as the last one resized', async () => {
    const { model, grid, yOf } = await setup([[0, CLIP_PPQ, 60, 100]]);
    swipe(grid, [xOf(CLIP_PPQ) - 4, yOf(60)], [xOf(2 * CLIP_PPQ + 20), yOf(60)]);
    tap(grid, xOf(3 * CLIP_PPQ + 20), yOf(62));
    expect(model.$clip.value.notes[1]).toEqual([3 * CLIP_PPQ, 2 * CLIP_PPQ, 62, 100]);
  });

  it('has no length: a loop of 4 bars, by the notes; plays from a bar of the loop by its ruler', async () => {
    const { modules, model, grid, yOf } = await setup([[0, SIXTEENTH, 60, 100]]);
    expect(screen.queryByRole('slider', { name: 'Bars' })).toBeNull();
    expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
    // a bar across: a tap on the second one, within the loop
    tap(grid, xOf(CLIP_BAR + 20), yOf(62));
    expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
    const [{ audioCtx }] = modules.synthCore;
    finger('pointerdown', screen.getByTestId('roll-ruler'), 1, xOf(CLIP_BAR + 50), 10);
    expect(model.$armed.value).toBe(true);
    expect(modules.transport[0].beatAt(audioCtx.currentTime + TRACK_LEAD)).toBeCloseTo(4, 6);
  });

  it('has the name, Save and Share in its header, no Close', async () => {
    await setup();
    expect(screen.getByLabelText('Clip name')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Save$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Share$/ })).toBeTruthy();
    expect(screen.queryByLabelText('Close')).toBeNull();
    expect(screen.queryByText('BPM')).toBeNull();
  });
});
