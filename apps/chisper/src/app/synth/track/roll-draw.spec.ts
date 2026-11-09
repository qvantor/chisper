import { CLIP_BAR, CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';
import { drawn } from '@chisper/ui-kit/test-utils';
import {
  drawGrid,
  drawHover,
  drawKeys,
  drawLane,
  drawNotes,
  drawRecording,
  noteBox,
  ROLL_COLORS,
  velocityColor,
} from './roll-draw';
import { laneY, RollView, tickX } from './roll-view';

// 4 bars across 1000 px, rows of 14 px, C5 (72) on top
const view: RollView = { tick0: 0, scale: 1000 / (4 * CLIP_BAR), top: 72, row: 14, width: 1000, height: 420 };

const canvas = () => {
  const element = document.createElement('canvas');
  element.width = 1000;
  element.height = 420;
  return { element, context: element.getContext('2d') as CanvasRenderingContext2D };
};

const green = (color: string) => Number(color.match(/\d+/g)?.[1]);

describe('roll draw', () => {
  it('takes its colors from the theme of the synth', () => {
    expect(ROLL_COLORS.background).toBe(theme.colors.primaryDark);
    expect(ROLL_COLORS.note).toBe(theme.colors.accent);
    expect(ROLL_COLORS.selected).toBe(theme.colors.thirdAccent);
    expect(ROLL_COLORS.loop).toBe(theme.colors.secondAccent);
    const themed = new Set(Object.values(theme.colors).map((color) => color.toLowerCase()));
    Object.values(ROLL_COLORS).forEach((color) => {
      if (!color.startsWith('rgba')) expect(themed.has(color.toLowerCase())).toBe(true);
    });
  });

  it('colors a note by its velocity: the full accent at the most, darker below', () => {
    expect(velocityColor(127)).toBe('rgb(46, 204, 113)');
    expect(velocityColor(127, true)).toBe('rgb(241, 196, 15)');
    const greens = [1, 32, 64, 100, 127].map((velocity) => green(velocityColor(velocity)));
    expect(greens).toEqual([...greens].sort((a, b) => a - b));
    expect(new Set(greens).size).toBe(greens.length);
  });

  it('puts a note in its row, a px apart from the next one', () => {
    const note: ClipNote = [CLIP_PPQ, CLIP_PPQ, 60, 100];
    expect(noteBox(view, note)).toEqual({
      x: tickX(view, CLIP_PPQ),
      y: 12 * 14 + 1,
      width: CLIP_PPQ * view.scale - 1,
      height: 12,
    });
    // a very short one stays visible
    expect(noteBox(view, [0, 1, 60, 100]).width).toBe(3);
  });

  it('draws the selected notes over the others, outlined', () => {
    const { element, context } = canvas();
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 60, 100],
      [0, CLIP_PPQ, 60, 50],
      [CLIP_BAR, CLIP_PPQ, 62, 127],
    ];
    drawNotes(context, view, notes, new Set([0]));
    const shapes = drawn(element);
    const fills = shapes.filter(({ op }) => op === 'fill');
    expect(fills.map(({ style }) => style)).toEqual([
      velocityColor(50),
      velocityColor(127),
      velocityColor(100, true),
    ]);
    expect(shapes.at(-1)).toMatchObject({ op: 'stroke', style: ROLL_COLORS.selectedEdge });
    // off the view: not drawn
    context.clearRect(0, 0, 1000, 420);
    drawNotes(context, { ...view, tick0: 2 * CLIP_BAR }, notes, new Set());
    expect(drawn(element)).toHaveLength(0);
  });

  it('draws the notes REC holds by their velocity, outlined red; none off the view', () => {
    const { element, context } = canvas();
    const held: ClipNote[] = [
      [0, CLIP_PPQ, 60, 90],
      [CLIP_BAR, CLIP_PPQ / 2, 64, 127],
    ];
    drawRecording(context, view, held);
    const shapes = drawn(element);
    expect(shapes.map(({ op, style }) => [op, style])).toEqual([
      ['fill', velocityColor(90)],
      ['stroke', ROLL_COLORS.recording],
      ['fill', velocityColor(127)],
      ['stroke', ROLL_COLORS.recording],
    ]);
    expect(ROLL_COLORS.recording).toBe(theme.colors.red);
    context.clearRect(0, 0, 1000, 420);
    drawRecording(context, { ...view, tick0: 2 * CLIP_BAR }, held);
    expect(drawn(element)).toHaveLength(0);
  });

  it('shades the part past the end of the loop, its end a line of the loop', () => {
    const { element, context } = canvas();
    drawGrid(context, view, CLIP_PPQ / 4, 2 * CLIP_BAR);
    const rects = drawn(element).map(({ rects: [rect], style }) => ({ rect, style }));
    const end = tickX(view, 2 * CLIP_BAR);
    expect(rects).toContainEqual({ rect: [end, 0, 1000 - end, 420], style: ROLL_COLORS.past });
    expect(rects.at(-1)).toEqual({ rect: [Math.round(end) - 1, 0, 2, 420], style: ROLL_COLORS.loop });
  });

  it('draws no rows nor keys under C0: the rest of a view past them empty', () => {
    // C1 (24) on top: C0 the 13th row, its bottom at 13 × 14 px
    const low = { ...view, top: 24 };
    const floor = 13 * 14;
    const grid = canvas();
    drawGrid(grid.context, low, CLIP_PPQ / 4, 2 * CLIP_BAR);
    expect(drawn(grid.element).at(-1)).toMatchObject({
      style: ROLL_COLORS.background,
      rects: [[0, floor, 1000, 420 - floor]],
    });
    const keys = canvas();
    drawKeys(keys.context, low, 56);
    const shapes = drawn(keys.element);
    expect(shapes.at(-1)).toMatchObject({
      style: ROLL_COLORS.background,
      rects: [[0, floor, 56, 420 - floor]],
    });
    // the keys over it only
    expect(shapes.slice(1, -1).every(({ rects }) => rects.every(([, y]) => y < floor))).toBe(true);
  });

  it('draws the note a press would add and the row under the pointer', () => {
    const { element, context } = canvas();
    drawHover(context, view, { pitch: 60, ghost: [0, CLIP_PPQ, 60], rubber: null });
    const [row, ghost] = drawn(element);
    expect(row.rects).toEqual([[0, 12 * 14, 1000, 14]]);
    expect(ghost.rects).toEqual([[0, 12 * 14 + 1, CLIP_PPQ * view.scale - 1, 12]]);
  });

  it('draws a velocity as a stem up to a head across, the notes of a chord one over another, the selected ones last', () => {
    const { element, context } = canvas();
    const lane = { ...view, height: 64 };
    // a chord, and a note a 64th long (its head within it)
    drawLane(
      context,
      lane,
      [
        [CLIP_PPQ, CLIP_PPQ, 60, 64],
        [CLIP_PPQ, CLIP_PPQ, 64, 100],
        [2 * CLIP_PPQ, CLIP_PPQ / 16, 67, 30],
      ],
      new Set([0])
    );
    const x = Math.round(tickX(lane, CLIP_PPQ));
    const y = (velocity: number) => Math.round(laneY(64, velocity));
    const rects = drawn(element).map(({ rects: [rect] }) => rect);
    expect(rects).toContainEqual([x, y(100), 1, 64 - y(100)]);
    expect(rects).toContainEqual([x, y(64), 1, 64 - y(64)]);
    // the heads after the stems, the selected one last: 10 px across, a short note's within it
    const short = Math.floor((CLIP_PPQ / 16) * lane.scale) - 1;
    expect(rects.slice(-3)).toEqual([
      [x, y(100) - 1, 10, 3],
      [Math.round(tickX(lane, 2 * CLIP_PPQ)), y(30) - 1, Math.max(3, short), 3],
      [x, y(64) - 1, 10, 3],
    ]);
    expect(drawn(element).at(-1)?.style).toBe(velocityColor(64, true));
  });
});
