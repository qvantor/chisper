import { readFileSync } from 'fs';
import { join } from 'path';
import { chainState, makeChain, renderChain } from '../../../../test-utils/chain-render';
import {
  responseMeasures,
  RT_OCTAVES,
  sceneChord,
  sceneDistance,
  sceneWindows,
} from '../../../../test-utils/reverb-scenes';
import { REVERB_PRESETS } from './reverb-presets';
import { FX_REGISTRY } from '.';

// The built-in presets of the reverb against the factory presets of the reverb of the Audio Unit they were fitted
// to (dsp/measurements/reverb-presets.json, scripts/renders/run.mjs --only=reverb-presets): of each the nearest of
// the same kind by its measures (Basin is mono and starts 110 ms late, the tails of Nitro ring for tens of seconds:
// no room of ours is one of them). The fit moved every knob but the depth on the energy of each octave over time of
// the response all wet, its width and the density of its echoes. The mix is ours (the Wet of a factory preset is a
// touch under a whole track: Ambient wash at it was 1 %): the chord is held to theirs at the mix that gives the wet
// signal against the dry one of their Wet, the level of our tail against theirs made up. Small room, Bright room
// and Vintage plate have no counterpart (none of the Audio Unit is a small room, a bright one or a dark plate),
// Default is the schema's

const REFERENCES: Record<string, string> = {
  'medium-room': 'Hall - Small Venue',
  'dark-chamber': 'Hall - Concert Hall',
  plate: 'Plate - Generic Plate',
  'vocal-plate': 'Plate - Studio',
  'large-hall': 'Hall - Auditorium',
  cathedral: 'Hall Luxury',
  lush: 'Vintage - Synesthesia',
  'ambient-wash': 'Nitrous - Wide Open',
};
// the tolerances: the worst preset of the fit and a margin. Two renders of a Hall of the Audio Unit are 2 dB of
// spectrum apart on the chord (reverb-measured.spec.ts); the RT60 of an octave in octaves (log2 of ours over theirs)
const SCENE = { spectrum: 4.2, tail: 6.5, held: 1 };
const RESPONSE = { rt60: 0.45, first: 30, side: 1.5 };

type Row = number[];
interface Measured {
  rate: number;
  octaves: number[];
  sceneTimes: number[];
  chord: number[];
  dry: Row[];
  presets: {
    name: string;
    rt60: number[];
    first: number;
    side: number;
    energy: number;
    gains: number[];
    scene: Row[];
  }[];
}
const measured: Measured = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../../dsp/measurements/reverb-presets.json'), 'utf8')
);
const R = measured.rate;
const CHORD = sceneChord(measured.chord, R);
const theirs = (name: string) => {
  const row = measured.presets.find((preset) => preset.name === name);
  if (!row) throw new Error(`no ${name} in reverb-presets.json`);
  return row;
};
const preset = (id: string) => {
  const found = REVERB_PRESETS.find((item) => item.id === id);
  if (!found) throw new Error(`no reverb preset ${id}`);
  return found;
};
// the response of ours all wet to an impulse at 0.3 s, 9 s long (as the renders)
const AT = Math.round(0.3 * R);
const IMPULSE = new Float32Array(9 * R);
IMPULSE[AT] = 0.5;
const responseOf = (params: Record<string, number>) => {
  const core = FX_REGISTRY.reverb.core(params as never, 120, R);
  const { left, right } = renderChain(
    makeChain(chainState(['reverb'], 1, { reverb: { params: core } }), R, false),
    [IMPULSE, IMPULSE]
  );
  return responseMeasures(left, right, IMPULSE, AT, R);
};
const octave = (centre: number) => RT_OCTAVES.findIndex(([c]) => c === centre);

jest.setTimeout(60000);

describe('the built-in reverb presets against the factory presets of the Audio Unit', () => {
  it('the octaves of the file are those the measures read', () => {
    expect(measured.octaves).toEqual(RT_OCTAVES.map(([centre]) => centre));
  });

  it('the stand passes the chord as it is', () => {
    const { spectrum, held } = sceneDistance(
      sceneWindows(CHORD, CHORD, measured.sceneTimes, R),
      measured.dry,
      measured.sceneTimes
    );
    expect(spectrum).toBeLessThan(0.3);
    expect(held).toBeLessThan(0.3);
  });

  it('every reference is a preset of ours and one of the Audio Unit', () => {
    Object.entries(REFERENCES).forEach(([id, name]) => {
      expect(preset(id).id).toBe(id);
      expect(theirs(name).name).toBe(name);
    });
  });

  // its response all wet: how long each octave rings, when it starts, how wide it is
  it.each(Object.entries(REFERENCES))('%s: the response is that of %s', (id, name) => {
    const ours = responseOf(preset(id).params);
    const reference = theirs(name);
    for (const centre of [250, 500, 1000, 2000, 4000]) {
      const k = octave(centre);
      expect(Math.abs(Math.log2(ours.rt60[k] / reference.rt60[k]))).toBeLessThan(RESPONSE.rt60);
    }
    expect(Math.abs(ours.first - reference.first)).toBeLessThan(RESPONSE.first);
    expect(Math.abs(Math.max(ours.side, -25) - Math.max(reference.side, -25))).toBeLessThan(RESPONSE.side);
  });

  // the chord through ours against the chord through theirs at its Wet
  it.each(Object.entries(REFERENCES))('%s: the chord through it is that of %s', (id, name) => {
    const { params } = preset(id);
    const reference = theirs(name);
    const [dryGain, wetGain] = reference.gains;
    const level = 10 ** ((reference.energy - responseOf(params).energy) / 20);
    const mix = (2 / Math.PI) * Math.atan((wetGain / dryGain) * level);
    const core = FX_REGISTRY.reverb.core(params, 120, R);
    const { left, right } = renderChain(
      makeChain(chainState(['reverb'], mix, { reverb: { params: core } }), R, false),
      [CHORD, CHORD]
    );
    const { spectrum, tail, held } = sceneDistance(
      sceneWindows(left, right, measured.sceneTimes, R),
      reference.scene,
      measured.sceneTimes
    );
    expect(spectrum).toBeLessThan(SCENE.spectrum);
    expect(tail).toBeLessThan(SCENE.tail);
    expect(held).toBeLessThan(SCENE.held);
  });
});
