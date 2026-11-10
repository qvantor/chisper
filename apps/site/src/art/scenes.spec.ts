import {
  SCENES,
  TRACK_PLAYHEAD,
  isScene,
  noiseDots,
  noiseWave,
  sceneAt,
  trackNotes,
  type SceneLine,
} from './scenes';
import { TRACK_CLIP } from './track';

describe('the waves behind the features', () => {
  it.each(SCENES)('%s draws lines across its band, inside it', (scene) => {
    for (const time of [0, 3.7, 11, 29]) {
      const lines = sceneAt(scene, time);
      expect(lines.length).toBeGreaterThan(0);
      for (const { points, alpha, width, color } of lines) {
        expect(points.length % 2).toBe(0);
        expect(points.length).toBeGreaterThanOrEqual(4);
        for (let i = 0; i < points.length; i += 2) {
          expect(points[i]).toBeGreaterThanOrEqual(0);
          expect(points[i]).toBeLessThanOrEqual(1);
          expect(Math.abs(points[i + 1])).toBeLessThanOrEqual(1.05);
          expect(Number.isFinite(points[i + 1])).toBe(true);
        }
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThanOrEqual(1);
        expect(width).toBeGreaterThan(0);
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it.each(SCENES)('%s moves with the time, the same at the same time', (scene) => {
    expect(sceneAt(scene, 2)).toEqual(sceneAt(scene, 2));
    expect(sceneAt(scene, 2)).not.toEqual(sceneAt(scene, 4.5));
  });

  it('spreads the voices of a unison apart from a middle where they meet', () => {
    const voices = sceneAt('unison', 0);
    expect(voices).toHaveLength(7);
    // at the middle of the band every voice has the level of the middle one
    const middle = (points: number[]) => points[points.length / 2 + 1];
    const centre = middle(voices[3].points);
    for (const voice of voices) expect(middle(voice.points)).toBeCloseTo(centre, 6);
    // at the edge they differ
    expect(voices[0].points[1]).not.toBeCloseTo(voices[6].points[1], 2);
  });

  it('clips the sine of the effects under its ceiling, flatter with more drive', () => {
    const [clean, ceiling, , clipped] = sceneAt('effects', 0);
    const peak = (points: number[]) => Math.max(...points.filter((_, i) => i % 2).map(Math.abs));
    expect(peak(clean.points)).toBeCloseTo(1, 2);
    expect(peak(clipped.points)).toBeLessThanOrEqual(ceiling.points[1] + 1e-9);
  });

  it('plays a wave whose frame changes along the band, each part in the color of its frame', () => {
    const [sine, ...parts] = sceneAt('synthesis', 0);
    expect(sine.alpha).toBeLessThan(0.5);
    expect(parts).toHaveLength(12);
    // the parts join into one line across the band
    expect(parts[0].points[0]).toBe(0);
    expect(parts.at(-1)?.points.at(-2)).toBeCloseTo(1, 9);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i].points.slice(0, 2)).toEqual(parts[i - 1].points.slice(-2));
    }
    // from the blue of a sine to the green of a saw somewhere along it
    expect(new Set(parts.map((part) => part.color)).size).toBeGreaterThan(4);
  });

  it('draws the noise as a quiet cloud of dots and its waves lit in white, pink and brown', () => {
    const [cloud, ...lit] = sceneAt('noise', 2);
    expect(cloud.color).toBe('#bdc3c7');
    expect(new Set(lit.map((layer) => layer.color))).toEqual(new Set(['#ecf0f1', '#f8a5c2', '#c58b5c']));
    for (const layer of [cloud, ...lit]) {
      expect(layer.grain).toBeGreaterThan(0);
      expect(layer.glow ?? 0).toBe(0);
    }
    // a lit dot brighter and larger than the cloud
    for (const layer of lit) {
      expect(layer.alpha).toBeGreaterThan(cloud.alpha);
      expect(layer.grain).toBeGreaterThan(cloud.grain ?? 0);
    }
    // every dot once at any time, most of them in the cloud
    const count = (layers: SceneLine[]) => layers.reduce((sum, layer) => sum + layer.points.length / 2, 0);
    for (const time of [0, 2, 30]) expect(count(sceneAt('noise', time))).toBe(noiseDots(0).length);
    expect(count([cloud])).toBeGreaterThan(count(lit));
    expect(count(lit)).toBeGreaterThan(300);
  });

  it('moves the dots of the noise smoothly, the same at the same time', () => {
    expect(sceneAt('noise', 5)).toEqual(sceneAt('noise', 5));
    const now = noiseDots(5);
    const next = noiseDots(5 + 1 / 30);
    now.forEach((dot, i) => {
      // (a dot drifting out on the right comes back on the left)
      const dx = Math.abs(next[i].x - dot.x);
      expect(Math.min(dx, 1 - dx)).toBeLessThan(0.002);
      expect(Math.abs(next[i].level - dot.level)).toBeLessThan(0.07);
    });
  });

  it('lights the dots a wave passes, gathered onto it, all across the band, and moves the waves on', () => {
    const time = 3;
    const dots = noiseDots(time);
    const lit = dots.filter((dot) => dot.light >= 0.25);
    for (const dot of lit) expect(Math.abs(dot.level - noiseWave(dot.wave, dot.x, time))).toBeLessThan(0.12);
    for (const wave of [0, 1, 2]) {
      const xs = lit.filter((dot) => dot.wave === wave).map((dot) => dot.x);
      expect(Math.min(...xs)).toBeLessThan(0.1);
      expect(Math.max(...xs)).toBeGreaterThan(0.9);
    }
    // a second later the waves are elsewhere: other dots lit
    expect(noiseWave(0, 0.5, time + 1)).not.toBeCloseTo(noiseWave(0, 0.5, time), 2);
    const later = noiseDots(time + 1);
    expect(later.filter((dot, i) => dot.light >= 0.25 !== dots[i].light >= 0.25).length).toBeGreaterThan(100);
  });

  it('keeps the waves and the dots of the noise within the band, the dots over all of it', () => {
    for (const time of [0, 7, 100]) {
      const dots = noiseDots(time);
      for (const dot of dots) {
        expect(Math.abs(dot.level)).toBeLessThanOrEqual(1);
        expect(dot.x).toBeGreaterThanOrEqual(0);
        expect(dot.x).toBeLessThan(1);
      }
      expect(Math.max(...dots.map((dot) => Math.abs(dot.level)))).toBeGreaterThan(0.9);
      expect(dots.filter((dot) => Math.abs(dot.level) > 0.5).length).toBeGreaterThan(dots.length / 4);
      for (let x = 0; x <= 1; x += 0.01)
        for (const wave of [0, 1, 2]) expect(Math.abs(noiseWave(wave, x, time))).toBeLessThan(0.7);
    }
  });

  it('flies the notes of the clip right to left, the loop over and over', () => {
    // as fast as the playhead goes through the loop: 0.6 beats a second, 12 beats across
    const step = 0.6 / 12;
    const now = trackNotes(4);
    const later = trackNotes(5);
    const whole = (notes: ReturnType<typeof trackNotes>) =>
      notes.filter(({ from, to }) => from > 0.1 && to < 0.9);
    for (const note of whole(later)) {
      const before = now.find(
        ({ from, level }) => level === note.level && Math.abs(from - step - note.from) < 1e-9
      );
      expect(before).toBeDefined();
      expect(before && before.to - step).toBeCloseTo(note.to, 9);
    }
    // a loop (16 beats) later, the same notes
    const sort = (notes: ReturnType<typeof trackNotes>) =>
      [...notes].sort((a, b) => a.from - b.from || a.level - b.level);
    const again = sort(trackNotes(4 + 16 / 0.6));
    sort(now).forEach((note, i) => {
      expect(again[i].from).toBeCloseTo(note.from, 9);
      expect(again[i].level).toBe(note.level);
    });
    // the band is never empty, its pitches those of the clip
    for (const time of [0, 7, 19.5, 100]) {
      const notes = trackNotes(time);
      expect(notes.length).toBeGreaterThan(20);
      expect(new Set(notes.map(({ level }) => level)).size).toBeGreaterThan(8);
      for (const { from, to, level } of notes) {
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeLessThanOrEqual(1);
        expect(to).toBeGreaterThan(from);
        expect(Math.abs(level)).toBeLessThanOrEqual(0.85 + 1e-9);
      }
    }
    expect(new Set(TRACK_CLIP.map(([, , pitch]) => pitch)).size).toBeGreaterThan(8);
  });

  it('lights a note while the playhead plays it, dims it after, leaves those ahead unlit', () => {
    for (const time of [0, 3.3, 12, 40]) {
      const notes = trackNotes(time);
      const playing = notes.filter(({ from, to }) => from <= TRACK_PLAYHEAD && to > TRACK_PLAYHEAD);
      expect(playing.length).toBeGreaterThan(0);
      for (const note of playing) expect(note.light).toBe(1);
      for (const note of notes.filter(({ from }) => from > TRACK_PLAYHEAD)) expect(note.light).toBe(0);
      // (a note that ends at the playhead has just been played)
      const past = notes.filter(({ to }) => to < TRACK_PLAYHEAD - 1e-9);
      for (const note of past) expect(note.light).toBeLessThan(1);
      // a note just played brighter than one played long ago
      const nearest = past.reduce((a, b) => (b.to > a.to ? b : a));
      const farthest = past.reduce((a, b) => (b.to < a.to ? b : a));
      expect(nearest.light).toBeGreaterThan(farthest.light);
      expect(farthest.light).toBe(0);
    }
  });

  it('draws the notes as bars, the unlit blue without a glow, the lit glowing to green, the playhead still', () => {
    const scene = sceneAt('track', 3);
    const bars = scene.filter((part) => part.bars !== undefined);
    expect(bars.length).toBeGreaterThanOrEqual(2);
    for (const { points, bars: fill } of bars) {
      expect(points.length % 4).toBe(0);
      expect(fill).toBeGreaterThan(0);
      expect(fill).toBeLessThan(1);
      // each a box: its top over its bottom, its left end before its right
      for (let i = 0; i < points.length; i += 4) {
        expect(points[i + 1]).toBeGreaterThan(points[i + 3]);
        expect(points[i + 2]).toBeGreaterThan(points[i]);
      }
    }
    const [unlit, ...lit] = bars;
    expect(unlit.color).toBe('#3498db');
    expect(unlit.glow).toBe(0);
    for (const layer of lit) {
      expect(layer.glow).toBeGreaterThan(0);
      expect(layer.alpha).toBeGreaterThan(unlit.alpha);
    }
    expect(lit.at(-1)?.color).toBe('#2ecc71');
    // every note on the band once
    const count = bars.reduce((sum, { points }) => sum + points.length / 4, 0);
    expect(count).toBe(trackNotes(3).length);
    // the playhead, the same at any time
    const playhead = (time: number) =>
      sceneAt('track', time).find(
        ({ points, bars: fill }) =>
          fill === undefined && points[0] === TRACK_PLAYHEAD && points[2] === TRACK_PLAYHEAD
      );
    expect(playhead(3)).toBeDefined();
    expect(playhead(17)).toEqual(playhead(3));
  });

  it('knows its scenes', () => {
    expect(isScene('filter')).toBe(true);
    expect(isScene('faq')).toBe(false);
  });
});
