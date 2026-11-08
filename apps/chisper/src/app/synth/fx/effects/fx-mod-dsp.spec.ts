import { FREE, lfoTable, LfoWire } from '../../common/lfo/lfo-curve';
import { FxNote, FxRoute, routedValue } from './fx-modulation';
import { createFxModLines } from './fx-mod-lines';
import { DELAY_LINES, FX_MOD_LINES, mixGains, slotLines } from './fx-mod-params';

const RATE = 48000;
const BLOCK = 128;
const ENV = { attack: 0.1, hold: 0, decay: 0.1, sustain: 0.5, release: 0.2 };
const FLAT = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
const note = (start = 0): FxNote => ({ envelopes: [FLAT, ENV, FLAT], start, release: null });
const time: FxRoute = { param: 'time', source: 1, amount: 0.4, min: 0.01, max: 1 };

// the lines rendered block by block from frame `from` for `blocks`: the output of each line
const render = (lines: ReturnType<typeof createFxModLines>, from: number, blocks: number) => {
  const outputs = Array.from({ length: FX_MOD_LINES }, () => new Float32Array(BLOCK * blocks));
  for (let b = 0; b < blocks; b++) {
    const channels = Array.from({ length: FX_MOD_LINES }, () => new Float32Array(BLOCK));
    lines.process(from + b * BLOCK, channels);
    channels.forEach((channel, k) => outputs[k].set(channel, b * BLOCK));
  }
  return outputs;
};

describe('createFxModLines', () => {
  it('outputs the offset of a knob its routes move: the knob moved - the knob, at the points of a block', () => {
    const lines = createFxModLines(RATE);
    lines.setNote(note());
    lines.setLine(DELAY_LINES.time, { routes: [time], base: 0.2, map: 'linear' });
    // past the glide into it
    const out = render(lines, 0, 80)[DELAY_LINES.time];
    for (let i = 960; i < 80 * BLOCK; i += 32)
      expect(out[i]).toBeCloseTo(routedValue(0.2, [time], note(), i / RATE) - 0.2, 6);
    // linear between the points
    expect(out[1000]).toBeCloseTo((out[992] * 24 + out[1024] * 8) / 32, 6);
    // the others nothing
    expect(render(lines, 80 * BLOCK, 1)[DELAY_LINES.fb].every((value) => value === 0)).toBe(true);
  });

  it('outputs zeros while every line is idle, whatever its outputs held', () => {
    const lines = createFxModLines(RATE);
    lines.setNote(note());
    const channels = Array.from({ length: FX_MOD_LINES }, () => new Float32Array(BLOCK).fill(0.5));
    lines.process(0, channels);
    expect(channels.every((channel) => channel.every((value) => value === 0))).toBe(true);
    // a line gone, once at 0, too
    lines.setLine(DELAY_LINES.time, { routes: [time], base: 0.2, map: 'linear' });
    render(lines, 0, 8);
    lines.setLine(DELAY_LINES.time, null);
    render(lines, 8 * BLOCK, 8);
    channels.forEach((channel) => channel.fill(0.5));
    lines.process(16 * BLOCK, channels);
    expect(channels.every((channel) => channel.every((value) => value === 0))).toBe(true);
  });

  it('maps the mix to the gains at equal power or linearly, the pan to the delay of each side', () => {
    const mix: FxRoute = { param: 'mix', source: 0, amount: 0.5, min: 0, max: 1 };
    const pan: FxRoute = { param: 'pan', source: 0, amount: 0.04, min: -0.05, max: 0.05 };
    const lines = createFxModLines(RATE);
    lines.setNote(note());
    const { dry, wet } = slotLines(2);
    lines.setLine(dry, { routes: [mix], base: 0.25, map: 'dry' });
    lines.setLine(wet, { routes: [mix], base: 0.25, map: 'wetLinear' });
    lines.setLine(DELAY_LINES.panL, { routes: [pan], base: -0.01, map: 'panL' });
    lines.setLine(DELAY_LINES.panR, { routes: [pan], base: -0.01, map: 'panR' });
    // ENV 1 flat at 1: the mix at 0.75, the pan at +0.03
    const outputs = render(lines, 0, 8);
    const last = (k: number) => outputs[k][8 * BLOCK - 1];
    expect(last(dry)).toBeCloseTo(mixGains(0.75)[0] - mixGains(0.25)[0], 6);
    expect(last(wet)).toBeCloseTo(0.5, 6);
    expect(last(DELAY_LINES.panL)).toBeCloseTo(0.03, 6);
    expect(last(DELAY_LINES.panR)).toBeCloseTo(-0.01, 6);
  });

  it('glides a change in 10 ms from where it was: no step; a line gone goes to 0 so, then it is idle', () => {
    const lines = createFxModLines(RATE);
    lines.setNote(note());
    const flat: FxRoute = { ...time, source: 0 };
    lines.setLine(DELAY_LINES.time, { routes: [flat], base: 0.2, map: 'linear' });
    let out = render(lines, 0, 8)[DELAY_LINES.time];
    // from 0 to +0.4 in 480 samples
    expect(out[0]).toBe(0);
    expect(out[240]).toBeCloseTo(0.2, 3);
    expect(out[600]).toBeCloseTo(0.4, 6);
    lines.setLine(DELAY_LINES.time, null);
    out = render(lines, 8 * BLOCK, 8)[DELAY_LINES.time];
    expect(out[0]).toBeCloseTo(0.4, 6);
    expect(out[240]).toBeCloseTo(0.2, 3);
    expect(out[500]).toBe(0);
    expect(lines.idle(DELAY_LINES.time)).toBe(true);
    // a new note: from where the line is
    lines.setLine(DELAY_LINES.time, { routes: [time], base: 0.2, map: 'linear' });
    render(lines, 16 * BLOCK, 16);
    lines.setNote(note(1));
    out = render(lines, 48000, 1)[DELAY_LINES.time];
    expect(Math.abs(out[1] - out[0])).toBeLessThan(0.01);
  });

  describe('a note sent ahead of its time (the track)', () => {
    const lfoWire = (period: number): LfoWire => ({
      mode: FREE,
      delay: 0,
      rise: 0,
      smooth: 0,
      phase: 0,
      anchor: { time: 0, phase: 0, period },
      table: lfoTable('sine'),
    });
    // [AI] Lo-Fi Tape Keys: the delay a tape, Time 16 ms moved ±2.97 ms by a free sine of 1.8 s
    const wow: FxRoute = { param: 'time', source: 4, amount: 0.006 * 0.99, min: 0.01, max: 1, bipolar: true };
    const tape = () => {
      const lines = createFxModLines(RATE);
      lines.setLfos({
        at: 0,
        instantly: true,
        lfos: [lfoWire(1.8), lfoWire(0.5), lfoWire(0.5), lfoWire(0.5)],
      });
      lines.setLine(DELAY_LINES.time, { routes: [wow], base: 0.016, map: 'linear' });
      return lines;
    };
    // the line over `blocks` from 0 with the notes of `starts` (seconds) each sent at the block `ahead` seconds
    // before it (0: the first block from its start, as a note of the keys comes)
    const play = (
      lines: ReturnType<typeof createFxModLines>,
      starts: number[],
      ahead: number,
      blocks: number
    ) => {
      const out = new Float32Array(blocks * BLOCK);
      const channels = Array.from({ length: FX_MOD_LINES }, () => new Float32Array(BLOCK));
      const waiting = [...starts];
      for (let b = 0; b < blocks; b++) {
        const frame = b * BLOCK;
        while (waiting.length && frame >= (waiting[0] - ahead) * RATE) lines.setNote(note(waiting.shift()));
        lines.process(frame, channels);
        out.set(channels[DELAY_LINES.time], frame);
      }
      return out;
    };
    const steepest = (out: Float32Array) => {
      let step = 0;
      for (let i = 1; i < out.length; i++) step = Math.max(step, Math.abs(out[i] - out[i - 1]));
      return step;
    };

    it('starts at its time: a free LFO on the delay Time stays on its clock, no step', () => {
      const starts = [0.3, 0.75, 1.1];
      const blocks = Math.ceil((1.3 * RATE) / BLOCK);
      const early = play(tape(), starts, 0.004, blocks);
      expect(early).toEqual(play(tape(), starts, 0, blocks));
      // past the glide into the line, as steep as the sine itself: 2.97 ms × 2π / 1.8 s a second
      const slope = (0.00297 * 2 * Math.PI) / 1.8 / RATE;
      expect(steepest(early.subarray(960))).toBeLessThan(slope * 1.01);
    });

    it('until its start the note before goes on, from its start the new one glides in', () => {
      const lines = createFxModLines(RATE);
      lines.setNote(note());
      lines.setLine(DELAY_LINES.time, { routes: [time], base: 0.2, map: 'linear' });
      // ENV 2 of the first note on its sustain: +0.2
      render(lines, 0, 200);
      const start = 200 * BLOCK + 300;
      lines.setNote(note(start / RATE));
      const before = render(lines, 200 * BLOCK, 3)[DELAY_LINES.time];
      expect(before.every((value) => Math.abs(value - 0.2) < 1e-6)).toBe(true);
      // the first block from its start: from the sustain towards the attack of the new note, in 10 ms
      const after = render(lines, 203 * BLOCK, 8)[DELAY_LINES.time];
      expect(after[0]).toBeCloseTo(0.2, 6);
      expect(after[480]).toBeCloseTo(
        routedValue(0.2, [time], note(start / RATE), (203 * BLOCK + 480) / RATE) - 0.2,
        6
      );
    });
  });

  it('runs the LFOs of its options and messages, without a note on their clocks', () => {
    const wire = (change: Partial<LfoWire> = {}): LfoWire => ({
      mode: FREE,
      delay: 0,
      rise: 0,
      smooth: 0,
      phase: 0,
      anchor: { time: 0, phase: 0, period: 1 },
      table: lfoTable('saw-up'),
      ...change,
    });
    const route: FxRoute = { ...time, source: 4, amount: 0.5 };
    const lines = createFxModLines(RATE, {
      lines: [{ routes: [route], base: 0.2, map: 'linear' }],
      note: null,
      knobRoutes: [],
      lfos: { at: 0, instantly: true, lfos: [wire(), wire(), wire(), wire()] },
    });
    const out = render(lines, 12000, 4)[DELAY_LINES.time];
    // a saw of 1 s at a quarter
    expect(out[0]).toBeCloseTo(0.5 * 0.25, 5);
    lines.setLfos({
      at: 0.3,
      lfos: [wire({ anchor: { time: 0.3, phase: 0.5, period: 1 } }), wire(), wire(), wire()],
    });
    expect(render(lines, 24000, 1)[DELAY_LINES.time][0]).toBeCloseTo(0.5 * 0.7, 3);
  });
});
