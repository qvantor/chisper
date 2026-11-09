import hexToRgba from 'hex-to-rgba';
import { CLIP_BAR, CLIP_PITCH_MIN, CLIP_PPQ, CLIP_VELOCITY_MAX, ClipNote } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';
import { midiName } from '../services';
import {
  isBlack,
  LANE_HEAD,
  laneHead,
  laneY,
  overviewWindow,
  overviewX,
  pitchY,
  RollView,
  tickX,
  visibleRows,
  xTick,
  yPitch,
} from './roll-view';

// the canvases of the piano roll, its lanes and the preview of the clip: the screens of the synth (the dark of its
// charts, their lines), its notes of the accent, the selected ones of the third accent, the loop of the second

const { colors } = theme;

export const ROLL_COLORS = {
  background: colors.primaryDark,
  // the rows of the white keys a little lighter than those of the black ones
  whiteRow: hexToRgba(colors.primaryDarkMediumContrast, 0.28),
  octave: colors.primaryDarkMediumContrast,
  line: hexToRgba(colors.primaryDarkMediumContrast, 0.7),
  beat: hexToRgba(colors.primaryDarkHighContrast, 0.3),
  bar: hexToRgba(colors.primaryDarkHighContrast, 0.65),
  // past the end of the loop
  past: hexToRgba('#000000', 0.38),
  loop: colors.secondAccent,
  note: colors.accent,
  selected: colors.thirdAccent,
  selectedEdge: colors.white,
  // the note under the pointer that a press would add, the row under it
  ghost: colors.accent,
  hoverRow: hexToRgba(colors.white, 0.045),
  rubber: colors.secondAccent,
  playhead: colors.white,
  // a note the playhead is in
  playing: hexToRgba(colors.white, 0.35),
  // a note held as REC records it
  recording: colors.red,
  label: colors.primaryDarkHighContrast,
  keyWhite: colors.primary,
  keyBlack: colors.primaryDarkMediumContrast,
  keyLine: colors.primaryLowContrast,
  keyLabel: colors.primaryHighContrast,
  sounding: colors.secondAccent,
  // a key a keyboard holds
  pressed: hexToRgba(colors.accent, 0.8),
};

const FONT = '"Inter Tight", sans-serif';

// a hex color between `from` (0) and `to` (1)
const mix = (from: string, to: string, share: number) => {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(from), rgb(to)];
  return `rgb(${a.map((value, i) => Math.round(value + (b[i] - value) * share)).join(', ')})`;
};

const velocityMix = (velocity: number, selected: boolean) =>
  mix(
    colors.primaryDarkMediumContrast,
    selected ? colors.thirdAccent : colors.accent,
    0.35 + (0.65 * velocity) / CLIP_VELOCITY_MAX
  );

// the colors of the velocities 0..CLIP_VELOCITY_MAX, of the notes and of the selected ones (made once: every note of
// every drawing takes one)
const VELOCITY_COLORS = [false, true].map((selected) =>
  Array.from({ length: CLIP_VELOCITY_MAX + 1 }, (_, velocity) => velocityMix(velocity, selected))
);

// a note of `velocity`: its color from the dark of the lines (soft) to the full accent (loud)
export const velocityColor = (velocity: number, selected = false) =>
  VELOCITY_COLORS[Number(selected)][velocity] ?? velocityMix(velocity, selected);

// the box of a note on the roll: a px between notes that follow each other, a px over and under it in its row
export const noteBox = (view: RollView, [start, duration, pitch]: readonly number[]) => {
  const x = tickX(view, start);
  return {
    x,
    y: pitchY(view, pitch) + 1,
    width: Math.max(3, duration * view.scale - 1),
    height: Math.max(2, view.row - 2),
  };
};

// the name of a note goes in it where it is this wide and its row this high
export const LABEL_WIDTH = 28;
export const LABEL_ROW = 11;

const visible = (view: RollView, { x, y, width, height }: ReturnType<typeof noteBox>) =>
  x <= view.width && x + width >= 0 && y <= view.height && y + height >= 0;

const box = (context: CanvasRenderingContext2D, { x, y, width, height }: ReturnType<typeof noteBox>) => {
  context.beginPath();
  context.roundRect(x, y, width, height, Math.min(2, height / 2));
};

// the edge of a note: a line of 1 px inside its box
const outline = (
  context: CanvasRenderingContext2D,
  { x, y, width, height }: ReturnType<typeof noteBox>,
  color: string
) => {
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, 1.5);
  context.stroke();
};

// the background: the rows of the white keys lighter, a line under each C, the lines of the grid (where they are 6 px
// apart at least; else of the beats, else of the bars), the part past the end of the loop shaded, its end a line
export const drawGrid = (context: CanvasRenderingContext2D, view: RollView, grid: number, length: number) => {
  const { width, height, row } = view;
  context.fillStyle = ROLL_COLORS.background;
  context.fillRect(0, 0, width, height);
  const first = yPitch(view, 0);
  for (let i = 0; i <= visibleRows(view); i += 1) {
    const pitch = first - i;
    if (pitch < CLIP_PITCH_MIN) break;
    const y = pitchY(view, pitch);
    if (!isBlack(pitch)) {
      context.fillStyle = ROLL_COLORS.whiteRow;
      context.fillRect(0, y, width, row);
    }
    if (((pitch % 12) + 12) % 12 === 0) {
      context.fillStyle = ROLL_COLORS.octave;
      context.fillRect(0, y + row - 1, width, 1);
    }
  }
  const step = [grid, CLIP_PPQ, CLIP_BAR].find((ticks) => ticks * view.scale >= 6) ?? CLIP_BAR;
  const to = xTick(view, width);
  for (let tick = Math.max(0, Math.floor(xTick(view, 0) / step) * step); tick <= to; tick += step) {
    context.fillStyle =
      tick % CLIP_BAR === 0 ? ROLL_COLORS.bar : tick % CLIP_PPQ === 0 ? ROLL_COLORS.beat : ROLL_COLORS.line;
    context.fillRect(Math.round(tickX(view, tick)), 0, 1, height);
  }
  const end = tickX(view, length);
  if (end < width) {
    context.fillStyle = ROLL_COLORS.past;
    context.fillRect(Math.max(0, end), 0, width - Math.max(0, end), height);
  }
  context.fillStyle = ROLL_COLORS.loop;
  context.fillRect(Math.round(end) - 1, 0, 2, height);
  underPitches(context, view, width);
};

// the part of a view under C0 (the rows of the notes short of its height): no rows, no keys
const underPitches = (context: CanvasRenderingContext2D, view: RollView, width: number) => {
  const floor = Math.max(0, pitchY(view, CLIP_PITCH_MIN - 1));
  if (floor >= view.height) return;
  context.fillStyle = ROLL_COLORS.background;
  context.fillRect(0, floor, width, view.height - floor);
};

// the notes: their velocity their color, the selected ones of their own color, outlined and glowing (over the
// others); their names in them where they fit
export const drawNotes = (
  context: CanvasRenderingContext2D,
  view: RollView,
  notes: readonly ClipNote[],
  selected: ReadonlySet<number>
) => {
  const label = view.row >= LABEL_ROW;
  context.font = `600 ${Math.min(10, view.row - 4)}px ${FONT}`;
  context.textBaseline = 'middle';
  const draw = (note: ClipNote, chosen: boolean) => {
    const rect = noteBox(view, note);
    if (!visible(view, rect)) return;
    const velocity = note[3];
    context.fillStyle = velocityColor(velocity, chosen);
    if (chosen) {
      context.shadowColor = hexToRgba(ROLL_COLORS.selected, 0.7);
      context.shadowBlur = 6;
    }
    box(context, rect);
    context.fill();
    context.shadowBlur = 0;
    if (chosen) outline(context, rect, ROLL_COLORS.selectedEdge);
    if (label && rect.width >= LABEL_WIDTH) {
      context.fillStyle =
        velocity >= CLIP_VELOCITY_MAX / 2 ? colors.primaryDark : hexToRgba(colors.white, 0.85);
      context.fillText(midiName(note[2]), Math.max(rect.x, 0) + 4, rect.y + rect.height / 2 + 0.5);
    }
  };
  notes.forEach((note, index) => !selected.has(index) && draw(note, false));
  notes.forEach((note, index) => selected.has(index) && draw(note, true));
};

// a rectangle of the selection as it is dragged: ticks [t0, t1], pitches [p0, p1]
export interface RubberBand {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
}

export interface RollHover {
  // the row under the pointer
  pitch: number | null;
  // the note a press would add: start, duration, pitch
  ghost: [number, number, number] | null;
  rubber: RubberBand | null;
}

// over the notes: the row under the pointer, the note a press would add, the rectangle of the selection
export const drawHover = (
  context: CanvasRenderingContext2D,
  view: RollView,
  { pitch, ghost, rubber }: RollHover
) => {
  if (pitch !== null) {
    context.fillStyle = ROLL_COLORS.hoverRow;
    context.fillRect(0, pitchY(view, pitch), view.width, view.row);
  }
  if (ghost) {
    const rect = noteBox(view, ghost);
    box(context, rect);
    context.fillStyle = hexToRgba(ROLL_COLORS.ghost, 0.22);
    context.fill();
    outline(context, rect, hexToRgba(ROLL_COLORS.ghost, 0.7));
  }
  if (rubber) {
    const x0 = tickX(view, Math.min(rubber.t0, rubber.t1));
    const x1 = tickX(view, Math.max(rubber.t0, rubber.t1));
    const y0 = pitchY(view, Math.max(rubber.p0, rubber.p1));
    const y1 = pitchY(view, Math.min(rubber.p0, rubber.p1)) + view.row;
    context.fillStyle = hexToRgba(ROLL_COLORS.rubber, 0.14);
    context.fillRect(x0, y0, x1 - x0, y1 - y0);
    context.strokeStyle = hexToRgba(ROLL_COLORS.rubber, 0.8);
    context.lineWidth = 1;
    context.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
  }
};

// the notes the playhead is in (at `tick`), lit over their color
export const drawPlaying = (
  context: CanvasRenderingContext2D,
  view: RollView,
  notes: readonly ClipNote[],
  tick: number
) => {
  context.fillStyle = ROLL_COLORS.playing;
  notes.forEach((note) => {
    const [start, duration] = note;
    if (tick < start || tick >= start + duration) return;
    const rect = noteBox(view, note);
    if (!visible(view, rect)) return;
    box(context, rect);
    context.fill();
  });
};

// the notes held as REC records them, up to where the output plays: their velocity their color, outlined red
export const drawRecording = (
  context: CanvasRenderingContext2D,
  view: RollView,
  notes: readonly ClipNote[]
) => {
  notes.forEach((note) => {
    const rect = noteBox(view, note);
    if (!visible(view, rect)) return;
    context.fillStyle = velocityColor(note[3]);
    box(context, rect);
    context.fill();
    outline(context, rect, ROLL_COLORS.recording);
  });
};

// the bars of the ruler (`view` of its size): a band under the loop, the numbers of the bars of the roll (`workspace`;
// of every 2nd, 4th… where they are close), the beats where they are 8 px apart, the part past the loop shaded; the
// bar under the pointer (`hoverBar`: a press plays from it) lit, a triangle of Play before its number
export const drawRuler = (
  context: CanvasRenderingContext2D,
  view: RollView,
  length: number,
  workspace: number,
  hoverBar: number | null = null
) => {
  const { width, height } = view;
  context.fillStyle = ROLL_COLORS.background;
  context.fillRect(0, 0, width, height);
  const end = tickX(view, length);
  if (hoverBar !== null) {
    const x = tickX(view, hoverBar * CLIP_BAR);
    context.fillStyle = hexToRgba(colors.white, 0.1);
    context.fillRect(x, 0, Math.min(end, tickX(view, (hoverBar + 1) * CLIP_BAR)) - x, height);
    // (at the left edge while the bar starts before it)
    const at = Math.max(0, x);
    context.fillStyle = ROLL_COLORS.note;
    context.beginPath();
    context.moveTo(at + 4, height / 2 - 5);
    context.lineTo(at + 10, height / 2 - 1);
    context.lineTo(at + 4, height / 2 + 3);
    context.closePath();
    context.fill();
  }
  context.fillStyle = hexToRgba(ROLL_COLORS.loop, 0.55);
  context.fillRect(
    Math.max(0, tickX(view, 0)),
    height - 3,
    Math.max(0, end - Math.max(0, tickX(view, 0))),
    3
  );
  context.font = `600 10px ${FONT}`;
  context.textBaseline = 'middle';
  const barWidth = CLIP_BAR * view.scale;
  const every = [1, 2, 4, 8, 16].find((n) => barWidth * n >= 28) ?? 32;
  const beats = CLIP_PPQ * view.scale >= 8;
  const to = Math.min(xTick(view, width), workspace);
  for (let bar = Math.max(0, Math.floor(xTick(view, 0) / CLIP_BAR)); bar * CLIP_BAR <= to; bar += 1) {
    const x = Math.round(tickX(view, bar * CLIP_BAR));
    // (the line at the end of the bars, no number)
    const labelled = bar % every === 0 && bar * CLIP_BAR < workspace;
    context.fillStyle = ROLL_COLORS.bar;
    context.fillRect(x, labelled ? 3 : height - 9, 1, labelled ? height - 6 : 6);
    if (labelled) {
      context.fillStyle = bar * CLIP_BAR < length ? colors.white : ROLL_COLORS.label;
      context.fillText(String(bar + 1), x + (bar === hoverBar ? 13 : 4), height / 2 - 1);
    }
    if (beats && bar * CLIP_BAR < workspace)
      for (let beat = 1; beat < 4; beat += 1) {
        context.fillStyle = ROLL_COLORS.beat;
        context.fillRect(Math.round(x + beat * CLIP_PPQ * view.scale), height - 7, 1, 4);
      }
  }
  if (end < width) {
    context.fillStyle = ROLL_COLORS.past;
    context.fillRect(Math.max(0, end), 0, width - Math.max(0, end), height);
  }
  context.fillStyle = ROLL_COLORS.octave;
  context.fillRect(0, height - 1, width, 1);
};

// the keys of the rows (`width` px): white and black as on the piano, the name of each C (C4 darker)
export const drawKeys = (context: CanvasRenderingContext2D, view: RollView, width: number) => {
  const { row } = view;
  context.fillStyle = ROLL_COLORS.keyWhite;
  context.fillRect(0, 0, width, view.height);
  context.font = `600 ${Math.min(10, Math.max(8, row - 4))}px ${FONT}`;
  context.textBaseline = 'middle';
  context.textAlign = 'right';
  const first = yPitch(view, 0);
  for (let i = 0; i <= visibleRows(view); i += 1) {
    const pitch = first - i;
    if (pitch < CLIP_PITCH_MIN) break;
    const y = pitchY(view, pitch);
    if (isBlack(pitch)) {
      context.fillStyle = ROLL_COLORS.keyBlack;
      context.beginPath();
      context.roundRect(0, y + 0.5, width * 0.6, row - 1, [0, 2, 2, 0]);
      context.fill();
    } else {
      context.fillStyle = ROLL_COLORS.keyLine;
      context.fillRect(0, y + row - 0.5, width, 0.5);
    }
    if (pitch % 12 === 0 && row >= 8) {
      context.fillStyle = pitch === 60 ? colors.primaryDark : ROLL_COLORS.keyLabel;
      context.fillText(midiName(pitch), width - 5, y + row / 2 + 0.5);
    }
  }
  underPitches(context, view, width);
  context.textAlign = 'left';
};

export interface KeyLights {
  hover: number | null;
  sounding: readonly number[];
  // the notes held by the keyboards (the computer's, the piano, MIDI, the keys of the roll)
  pressed: readonly number[];
  selected: ReadonlySet<number>;
}

// over the keys: those the track plays (as the piano lights them), those the keyboards hold of the color of the notes
// (over them), the one of the row under the pointer, a mark of the third accent on the pitches of the selected notes
export const drawKeyLights = (
  context: CanvasRenderingContext2D,
  view: RollView,
  width: number,
  { hover, sounding, pressed, selected }: KeyLights
) => {
  const key = (pitch: number, color: string) => {
    context.fillStyle = color;
    context.fillRect(0, pitchY(view, pitch) + 0.5, isBlack(pitch) ? width * 0.6 : width, view.row - 1);
  };
  sounding.forEach((pitch) => key(pitch, hexToRgba(ROLL_COLORS.sounding, 0.75)));
  pressed.forEach((pitch) => key(pitch, ROLL_COLORS.pressed));
  if (hover !== null) key(hover, hexToRgba(ROLL_COLORS.note, 0.4));
  context.fillStyle = ROLL_COLORS.selected;
  selected.forEach((pitch) => context.fillRect(width - 3, pitchY(view, pitch) + 1, 3, view.row - 2));
};

// the velocities under the roll (`view` of the lane's size): at each start a stem from the bottom up to a head, a bar
// across (`laneHead`: the notes of a chord one over another on one stem), of the color of its note, the selected ones
// over the others, the heads over the stems; a line at the middle
export const drawLane = (
  context: CanvasRenderingContext2D,
  view: RollView,
  notes: readonly ClipNote[],
  selected: ReadonlySet<number>
) => {
  const { width, height } = view;
  context.fillStyle = ROLL_COLORS.background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = ROLL_COLORS.line;
  context.fillRect(0, Math.round(laneY(height, CLIP_VELOCITY_MAX / 2)), width, 1);
  context.fillStyle = ROLL_COLORS.octave;
  context.fillRect(0, 0, width, 1);
  const shown = notes.flatMap((note, index) => {
    const x = Math.round(tickX(view, note[0]));
    return x < -LANE_HEAD || x > width ? [] : [{ note, x, chosen: selected.has(index) }];
  });
  // the selected ones last
  const ordered = [...shown.filter(({ chosen }) => !chosen), ...shown.filter(({ chosen }) => chosen)];
  ordered.forEach(({ note, x, chosen }) => {
    const y = Math.round(laneY(height, note[3]));
    context.fillStyle = velocityColor(note[3], chosen);
    context.fillRect(x, y, 1, height - y);
  });
  ordered.forEach(({ note, x, chosen }) => {
    const y = Math.round(laneY(height, note[3]));
    context.fillStyle = velocityColor(note[3], chosen);
    context.fillRect(x, y - 1, laneHead(view, note), 3);
  });
};

// the bars of the roll in a strip over it (`width` × `height`): a line at each bar, the notes over the pitches they
// span (their velocity their color), the part past the loop shaded, its end a line
export const drawOverview = (
  context: CanvasRenderingContext2D,
  notes: readonly ClipNote[],
  length: number,
  workspace: number,
  width: number,
  height: number
) => {
  const x = (tick: number) => overviewX(workspace, width, tick);
  context.fillStyle = ROLL_COLORS.background;
  context.fillRect(0, 0, width, height);
  for (let bar = CLIP_BAR; bar < workspace; bar += CLIP_BAR) {
    context.fillStyle = ROLL_COLORS.line;
    context.fillRect(Math.round(x(bar)), 0, 1, height);
  }
  if (notes.length) {
    const pitches = notes.map(([, , pitch]) => pitch);
    const low = Math.min(...pitches);
    const range = Math.max(1, Math.max(...pitches) - low);
    notes.forEach(([start, duration, pitch, velocity]) => {
      context.fillStyle = velocityColor(velocity);
      const y = 4 + (1 - (pitch - low) / range) * (height - 10);
      context.fillRect(x(start), y, Math.max(1.5, x(start + duration) - x(start) - 0.5), 2);
    });
  }
  const end = x(length);
  context.fillStyle = ROLL_COLORS.past;
  context.fillRect(end, 0, width - end, height);
  context.fillStyle = ROLL_COLORS.loop;
  context.fillRect(Math.round(end) - 1, 0, 2, height);
};

// the window of the view over the overview (a canvas of its own: a scroll draws nothing else again), a grip on each
// edge (dragged: the zoom)
export const drawOverviewWindow = (
  context: CanvasRenderingContext2D,
  view: RollView,
  workspace: number,
  width: number,
  height: number
) => {
  const [x0, x1] = overviewWindow(view, workspace, width);
  context.fillStyle = hexToRgba(colors.white, 0.1);
  context.fillRect(x0, 0, x1 - x0, height);
  context.strokeStyle = hexToRgba(colors.white, 0.45);
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x0 + 0.5, 0.5, Math.max(1, x1 - x0 - 1), height - 1, 3);
  context.stroke();
  // the grips of its edges
  context.fillStyle = hexToRgba(colors.white, 0.8);
  [x0 + 3, x1 - 5].forEach((grip) => {
    context.beginPath();
    context.roundRect(grip, height / 2 - 5, 2, 10, 1);
    context.fill();
  });
};

// the clip in a small window: a line at each bar, the notes over the loop across, their pitches over the height (a
// margin of a row), colored by their velocity
export const drawPreview = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  notes: readonly ClipNote[],
  length: number
) => {
  context.clearRect(0, 0, width, height);
  for (let bar = CLIP_BAR; bar < length; bar += CLIP_BAR) {
    context.fillStyle = ROLL_COLORS.line;
    context.fillRect(Math.round((bar / length) * width), 0, 1, height);
  }
  if (!notes.length) return;
  const pitches = notes.map(([, , pitch]) => pitch);
  const low = Math.min(...pitches) - 1;
  const high = Math.max(...pitches) + 1;
  const row = Math.min(6, height / (high - low + 1));
  const offset = (height - (high - low + 1) * row) / 2;
  notes.forEach(([start, duration, pitch, velocity]) => {
    const x = (start / length) * width;
    const w = Math.max(1.5, (Math.min(duration, length - start) / length) * width - 0.5);
    context.fillStyle = velocityColor(velocity);
    context.beginPath();
    context.roundRect(x, offset + (high - pitch) * row, w, Math.max(1, row - 1), 1);
    context.fill();
  });
};
