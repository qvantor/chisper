import {
  CLIP_BAR,
  CLIP_LENGTH_MAX,
  CLIP_PITCH_MAX,
  CLIP_PITCH_MIN,
  CLIP_PPQ,
  CLIP_VELOCITY_MAX,
  CLIP_VELOCITY_MIN,
  ClipNote,
} from '@chisper/preset-schema';
import { clamp, roundTick, snapTick } from './track-edit';

// the view of the piano roll: ticks across (from `tick0`, `scale` px a tick), pitches down (`top` at the top row,
// `row` px each), on a canvas of `width` × `height` css px. Pure: the canvases draw by it (roll-draw.ts), the
// pointer maps back

export interface RollView {
  tick0: number;
  scale: number;
  top: number;
  row: number;
  width: number;
  height: number;
}

export const ROW_MIN = 6;
export const ROW_MAX = 32;
export const ROW_DEFAULT = 14;
// px a tick: from a bar across 32 px to a 64th across 48 px
export const SCALE_MIN = 32 / CLIP_BAR;
export const SCALE_MAX = 48 / (CLIP_PPQ / 16);
// a step of the zoom keys (−, +)
export const ZOOM_STEP = 1.5;

const BLACK = [1, 3, 6, 8, 10];
export const isBlack = (pitch: number) => BLACK.includes(((pitch % 12) + 12) % 12);

export const tickX = ({ tick0, scale }: RollView, tick: number) => (tick - tick0) * scale;
export const xTick = ({ tick0, scale }: RollView, x: number) => tick0 + x / scale;
export const pitchY = ({ top, row }: RollView, pitch: number) => (top - pitch) * row;
// the pitch of the row under y
export const yPitch = ({ top, row }: RollView, y: number) => top - Math.floor(y / row);
// the pitches the view shows rows of
export const visibleRows = ({ height, row }: RollView) => Math.ceil(height / row);
// the ticks across the view
export const visibleTicks = ({ width, scale }: RollView) => width / scale;

// the top row of a view `height` px high within the pitches: the rows under it end at C0 at most, C0 whole at the
// bottom (the px under it empty)
export const clampTop = (top: number, { height, row }: Pick<RollView, 'height' | 'row'>) =>
  Math.min(CLIP_PITCH_MAX, Math.max(CLIP_PITCH_MIN + Math.floor(height / row) - 1, Math.round(top)));
// whether a row is of a pitch of a note (C0..G9)
export const inPitches = (pitch: number) => pitch >= CLIP_PITCH_MIN && pitch <= CLIP_PITCH_MAX;

// the share of the width the bars take in a fitted view (the flag of the end of the loop within the width)
const FIT_SHARE = 0.96;

// the scale a view of `width` px shows `span` ticks at (within its fitted share), within the scales
const fitScale = (width: number, span: number) => clamp((width * FIT_SHARE) / span, SCALE_MIN, SCALE_MAX);

// the ticks a view shows at most across the bars of the roll (`workspace`): them in its fitted share
const extentOf = (workspace: number) => workspace / FIT_SHARE;

// a view of `ticks` across from the start, the notes (or C4) in the middle of the height
export const viewAcross = (
  notes: readonly ClipNote[],
  width: number,
  height: number,
  row: number,
  ticks: number
): RollView => {
  const scale = clamp(width / ticks, SCALE_MIN, SCALE_MAX);
  const pitches = notes.map(([, , pitch]) => pitch);
  const middle = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
  const rows = Math.ceil(height / row);
  return { tick0: 0, scale, top: clampTop(middle + rows / 2, { height, row }), row, width, height };
};

// a view of `span` ticks (all of `length` by default) in its fitted share of the width
export const fitView = (
  notes: readonly ClipNote[],
  length: number,
  width: number,
  height: number,
  row = ROW_DEFAULT,
  span = length
): RollView => viewAcross(notes, width, height, row, span / FIT_SHARE);

// Fit: the loop (`length`) and a bar after it across the whole width, from the start (the end of the loop a bar
// from the right edge), the notes in the middle of the height
export const fitLoop = (
  notes: readonly ClipNote[],
  length: number,
  width: number,
  height: number,
  row = ROW_DEFAULT
): RollView => viewAcross(notes, width, height, row, length + CLIP_BAR);

// px past an edge of the view the end of the loop may be (a tick at the edge in floats)
const EDGE_SLACK = 0.5;
// whether the end of the loop at `tick` is on the screen of the view (its line at an edge too)
export const endInView = (view: RollView, tick: number) => {
  const x = tickX(view, tick);
  return x >= -EDGE_SLACK && x <= view.width + EDGE_SLACK;
};

// the end of the loop dragged to `tick`: to the nearest line of `step` within the view (its line never leaves the
// screen), a beat to the longest loop
export const loopEndAt = (view: RollView, tick: number, step: number) => {
  let end = roundTick(clamp(tick, view.tick0, xTick(view, view.width)), step);
  if (tickX(view, end) > view.width + EDGE_SLACK) end -= step;
  if (tickX(view, end) < -EDGE_SLACK) end += step;
  return clamp(end, CLIP_PPQ, CLIP_LENGTH_MAX);
};

// a view within the bars of the roll: no narrower than all of them across, scrolled from their start up to their
// end
export const clampView = (view: RollView, workspace: number): RollView => {
  const scale = Math.max(view.scale, fitScale(view.width, workspace));
  const tick0 = clamp(view.tick0, 0, Math.max(0, extentOf(workspace) - view.width / scale));
  return scale === view.scale && tick0 === view.tick0 ? view : { ...view, scale, tick0 };
};

// wider (factor > 1) or narrower across, around x: the tick under it stays there
export const zoomAt = (view: RollView, factor: number, x = view.width / 2): RollView => {
  const scale = clamp(view.scale * factor, SCALE_MIN, SCALE_MAX);
  const tick = xTick(view, x);
  return { ...view, scale, tick0: clamp(tick - x / scale, 0, CLIP_LENGTH_MAX) };
};

// taller or lower rows: the top row stays
export const zoomRows = (view: RollView, factor: number): RollView => {
  const row = clamp(view.row * factor, ROW_MIN, ROW_MAX);
  return { ...view, row, top: clampTop(view.top, { height: view.height, row }) };
};

// moved across by `ticks`, down by `rows` (up: fewer)
export const scrollView = (view: RollView, ticks: number, rows = 0): RollView => ({
  ...view,
  tick0: clamp(view.tick0 + ticks, 0, CLIP_LENGTH_MAX),
  top: clampTop(view.top - rows, view),
});

// following the playhead: as the following starts (no `previous`: F or REC while the track plays, Play with it on)
// a view without the playhead pages to it; then a view the playhead was in (at `previous`) and has left (on, or round
// the loop to its start) pages to where it is now. It pages to its bar when that is in the first half of the view;
// null: it stays (the playhead is in it, or was not: a view scrolled away is left alone)
export const followView = (view: RollView, previous: number | null, tick: number): number | null => {
  const span = visibleTicks(view);
  const within = (at: number) => at >= view.tick0 && at < view.tick0 + span;
  if (within(tick) || (previous !== null && !within(previous))) return null;
  const bar = Math.floor(tick / CLIP_BAR) * CLIP_BAR;
  return tick - bar < span / 2 ? bar : tick;
};

// the overview of the bars over the roll (`width` px): all of them across, the window of the view on it (px); its
// edges dragged zoom the view (the other edge stays), the window dragged scrolls it
export const overviewX = (workspace: number, width: number, tick: number) =>
  (tick / extentOf(workspace)) * width;
export const overviewTickAt = (workspace: number, width: number, x: number) =>
  (x / width) * extentOf(workspace);
export const overviewWindow = (view: RollView, workspace: number, width: number): [number, number] => [
  clamp(overviewX(workspace, width, view.tick0), 0, width),
  clamp(overviewX(workspace, width, view.tick0 + visibleTicks(view)), 0, width),
];

// px of an edge of the window a press takes
export const OVERVIEW_EDGE = 6;
export type OverviewHit = 'start' | 'end' | 'inside' | 'outside';
export const overviewHit = (view: RollView, workspace: number, width: number, x: number): OverviewHit => {
  const [x0, x1] = overviewWindow(view, workspace, width);
  // (the nearer edge where the window is narrow)
  const [d0, d1] = [Math.abs(x - x0), Math.abs(x - x1)];
  if (Math.min(d0, d1) <= OVERVIEW_EDGE) return d0 < d1 ? 'start' : 'end';
  return x > x0 && x < x1 ? 'inside' : 'outside';
};

// an edge of the window dragged to x: the view as wide as the window then, the other edge where it was
export const overviewResize = (
  view: RollView,
  workspace: number,
  width: number,
  x: number,
  edge: 'start' | 'end'
): RollView => {
  const tick = clamp(overviewTickAt(workspace, width, x), 0, extentOf(workspace));
  const least = view.width / SCALE_MAX;
  const end = view.tick0 + visibleTicks(view);
  const [from, to] =
    edge === 'start' ? [Math.min(tick, end - least), end] : [view.tick0, Math.max(tick, view.tick0 + least)];
  const scale = clamp(view.width / (to - from), SCALE_MIN, SCALE_MAX);
  return clampView({ ...view, scale, tick0: edge === 'start' ? to - view.width / scale : from }, workspace);
};

// the note a press at `tick` of `pitch` adds: [start, duration, pitch] at the line of the grid at or before it (snap
// off: the tick), of `duration` within the bars of the roll (`workspace`); null: past them or out of the pitches
export const noteToAdd = (
  tick: number,
  pitch: number,
  step: number,
  snap: boolean,
  workspace: number,
  duration: number
): [number, number, number] | null => {
  if (tick < 0 || tick >= workspace || !inPitches(pitch)) return null;
  const start = snapTick(tick, step, snap);
  return [start, Math.min(duration, workspace - start), pitch];
};

// the right edge of a note: a press within this many px of it resizes it
export const EDGE_PX = 6;

// the lane of the velocities: each note a stem from the bottom at its start up to its head, a bar across (HEAD px at
// most, within the note: the notes of a chord one over another on one stem), within the lane (PAD px from its edges),
// 0 at the bottom, the most at the top
export const LANE_HEAD = 10;
const LANE_PAD = 4;
// px of the head of a note across: within the note (a px before the next one), 3 at least
export const laneHead = (view: RollView, [start, duration]: readonly number[]) =>
  clamp(Math.floor(tickX(view, start + duration) - tickX(view, start)) - 1, 3, LANE_HEAD);
export const laneY = (height: number, velocity: number) =>
  LANE_PAD + (1 - velocity / CLIP_VELOCITY_MAX) * (height - 2 * LANE_PAD);
// the velocity at y, within the velocities of a note (a pointer dragged past the lane: its edge)
export const laneVelocity = (height: number, y: number) =>
  clamp(
    Math.round((1 - (y - LANE_PAD) / Math.max(1, height - 2 * LANE_PAD)) * CLIP_VELOCITY_MAX),
    CLIP_VELOCITY_MIN,
    CLIP_VELOCITY_MAX
  );

// of some notes the one whose head is nearest y on a lane `height` px high (the first of those as near)
export const headAt = (notes: readonly ClipNote[], indexes: readonly number[], height: number, y: number) =>
  indexes.reduce((best, index) =>
    Math.abs(laneY(height, notes[index][3]) - y) < Math.abs(laneY(height, notes[best][3]) - y) ? index : best
  );

// px from a stem or its heads a press takes it within
export const STEM_REACH = 6;

// the px across of the stem of some notes (on one pixel) and their heads, `distance` px wider on both sides
export const stemSpan = (
  notes: readonly ClipNote[],
  view: RollView,
  indexes: readonly number[],
  distance = STEM_REACH
): [number, number] => {
  const starts = indexes.map((index) => tickX(view, notes[index][0]));
  const ends = indexes.map((index, i) => starts[i] + laneHead(view, notes[index]));
  return [Math.min(...starts) - distance, Math.max(...ends) + distance];
};

// the notes of the stem nearest x within `distance` px of it or of the heads on it (a press on a head or beside it
// takes it): all of those drawn there, on that pixel (a chord: its notes together); none: []. `among`: of those notes
// only (the selected ones: a stem beside theirs doesn't take the press)
export const stemNotes = (
  notes: readonly ClipNote[],
  view: RollView,
  x: number,
  among?: ReadonlySet<number>,
  distance = STEM_REACH
): number[] => {
  let best = -1;
  // px from the stem and its head, then from the stem (of two heads over x the nearer stem)
  let nearest = [distance, Infinity];
  notes.forEach((note, index) => {
    if (among && !among.has(index)) return;
    const stem = tickX(view, note[0]);
    const end = stem + laneHead(view, note);
    const d = [x < stem ? stem - x : x > end ? x - end : 0, Math.abs(x - stem)];
    if (d[0] < nearest[0] || (d[0] === nearest[0] && d[1] <= nearest[1])) {
      nearest = d;
      best = index;
    }
  });
  if (best < 0) return [];
  const stem = Math.round(tickX(view, notes[best][0]));
  return notes.flatMap(([start], index) =>
    (!among || among.has(index)) && Math.round(tickX(view, start)) === stem ? [index] : []
  );
};
