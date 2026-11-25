// the processor state of the Audio Unit (`host state`) and the tables it plays: a magic (9 bytes),
// the length of a JSON header (u64), the header (its `hash` the md5 of the zstd frame), the size of
// the payload (u32), 2 (u32), a zstd frame of the payload: the CBOR of its modules (cbor.mjs). Oscillator A
// (`Oscillator0`) plays the table at the `relativePathToWT` of its `WTOsc0` (under the folder of its tables,
// RENDERS_TABLES) and has its `plainParams` ("default", or a map of the ones not at their default:
// kParamDetuneMode…).
// A state with them swapped plays a table of ours, written into User of that folder (the tables of its
// user), with the params we set. A mod slot (`ModSlot<i>`) routes a source (its index: 25 Macro 1) to a param of a
// module (its id and name: A Uni Blend is 27, kParamDetuneWid, of `Oscillator` 0) by `kParamAmount` (-100..100% of
// the travel of the knob) and `kParamBipolar`
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { decode, encode, get, set } from './cbor.mjs';

// the folder of the tables of the Audio Unit: RENDERS_TABLES of .env (run.mjs reads it)
export const tables = () => {
  if (!process.env.RENDERS_TABLES)
    throw new Error('RENDERS_TABLES of .env: the folder of the tables of the Audio Unit');
  return process.env.RENDERS_TABLES;
};

// the folder of its noise samples (`relativePathToNoiseSample` is under it): beside the tables, in Samples
export const noisesFolder = () => tables().replace(/Tables\/?$/, 'Samples/Factory Non-Tonal/Noises');

// the folder of the factory presets of its reverb (a file each): beside the tables, in Effect Chains
export const reverbPresetsFolder = () => tables().replace(/Tables\/?$/, 'Effect Chains/Reverb/Factory');

// a value of CBOR as plain JS: a number of any width, a name, a map as an object, an array
const plain = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if ('map' in value) return Object.fromEntries(value.map.map(([k, v]) => [k.text ?? k, plain(v)]));
  if ('array' in value) return value.array.map(plain);
  if ('f16' in value) {
    const n = value.f16;
    const [sign, exponent, fraction] = [n >> 15 ? -1 : 1, (n >> 10) & 31, n & 1023];
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    return exponent === 31
      ? fraction
        ? NaN
        : sign * Infinity
      : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  }
  if ('f32' in value) return value.f32;
  if ('f64' in value) return value.f64;
  if ('uint' in value) return value.uint;
  if ('neg' in value) return -1 - value.neg;
  if ('text' in value) return value.text;
  return value;
};

// the plain params of the effect `module` (FXReverb…) of a preset of an effect (its file: the container of a state,
// its modules the effect alone), as numbers and names; {} where they are all at their defaults
export const fxPresetParams = (file, module = 'FXReverb') => {
  const bytes = readFileSync(file);
  const length = Number(bytes.readBigUInt64LE(9));
  const doc = plain(decode(zlib.zstdDecompressSync(bytes.subarray(17 + length + 8))));
  const find = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node[module]) return node[module];
    for (const child of Object.values(node)) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  const effect = find(doc);
  if (!effect) throw new Error(`no ${module} in ${file}`);
  return effect.plainParams && effect.plainParams !== 'default' ? effect.plainParams : {};
};

// a small unsigned integer of CBOR as the states have it (one of 24 and up is encoded on a byte of its own)
const uint = (n) => (n < 24 ? n : { uint: n, info: 24 });

// the init state (`host state`) with oscillator i of `oscs` (A, B: `Oscillator<i>`) on `Tables/<path>` (a table of
// `frames` frames of 2048 samples) and with its plain params `params`; one not listed keeps the init's. Mod slot i
// of `slots` routes `source` (LFO 1..10: 6..15, Macro 1: 25) to `param` (its id) named `name` of `Oscillator<osc>`
// by `amount` (%), `bipolar`; of an effect of the main rack `type` is its module (FXDelay: kParamWet 1, kParamFreq
// 2, kParamBW 3, kParamTimeL 6, kParamTimeR 7, kParamFeedback 9) and `osc` its index in the rack (0 the first).
// `noise` puts the noise oscillator (`Oscillator3`, its `NoiseOsc3`) on the sample at `path` (under the noises of
// the Audio Unit, noisesFolder(): `frames` frames of `channels` at `rate`) with the plain params of its sampler
// `params` (kParamOneShot…). `fx` is the chain of the main rack (`FXRack0`, empty in the init state): each effect
// { module, type, params, kept } an item { <module>: { plainParams, ...kept }, type } (a compressor is `FXComp`,
// type 5, a chorus `FXChorus`, type 3), its plain params not listed at their defaults; their values are floats of
// 32 bits (the host renders silence on some written as doubles). `kept` is what the module keeps beside its
// params, floats too (the chorus the phase of its LFO, `lfophasor`: 0..1 of a cycle)
export const editedState = (initFile, oscs, slots = [], noise = null, fx = null) => {
  const init = readFileSync(initFile);
  const length = Number(init.readBigUInt64LE(9));
  const header = JSON.parse(init.subarray(17, 17 + length).toString());
  const doc = decode(zlib.zstdDecompressSync(init.subarray(17 + length + 8)));
  oscs.forEach(({ path, frames, params }, i) => {
    const osc = get(doc, `Oscillator${i}`);
    if (path) {
      const table = get(osc, `WTOsc${i}`);
      set(table, 'relativePathToWT', path);
      set(table, 'numFrames', frames * 2048);
    }
    if (params) set(osc, 'plainParams', { map: Object.entries(params) });
  });
  if (noise) {
    const sampler = get(get(doc, 'Oscillator3'), 'NoiseOsc3');
    set(sampler, 'relativePathToNoiseSample', noise.path);
    set(sampler, 'numFrames', noise.frames);
    set(sampler, 'numChannels', noise.channels);
    set(sampler, 'sampleRate', noise.rate);
    if (noise.params) set(sampler, 'plainParams', { map: Object.entries(noise.params) });
  }
  if (fx)
    set(get(doc, 'FXRack0'), 'FX', {
      array: fx.map(({ module, type, params = {}, kept = {} }) => {
        // (a param that is a name, the Type of a reverb, is written as it is)
        const floats = (values) =>
          Object.entries(values).map(([key, value]) => [
            key,
            typeof value === 'string' ? value : { f32: value },
          ]);
        const plain = floats(params);
        return {
          map: [
            [module, { map: [['plainParams', plain.length ? { map: plain } : 'default'], ...floats(kept)] }],
            ['kUIParamMixOrGain', { f32: 0 }],
            ['type', uint(type)],
          ],
        };
      }),
    });
  slots.forEach(({ source, osc, param, name, amount, bipolar, type = 'Oscillator' }, i) => {
    const params = [['kParamAmount', { f64: amount }], ...(bipolar ? [['kParamBipolar', { f32: 1 }]] : [])];
    set(doc, `ModSlot${i}`, {
      map: [
        ['destModuleID', uint(osc)],
        ['destModuleParamID', uint(param)],
        ['destModuleParamName', name],
        ['destModuleTypeString', type],
        ['plainParams', { map: params, info: params.length }],
        ['source', { array: [uint(source), 0], info: 2 }],
      ],
      info: 6,
    });
  });
  const payload = encode(doc);
  const zstd = zlib.zstdCompressSync(payload);
  header.hash = crypto.createHash('md5').update(zstd).digest('hex');
  const json = Buffer.from(JSON.stringify(header));
  const sizes = Buffer.alloc(16);
  sizes.writeBigUInt64LE(BigInt(json.length), 0);
  sizes.writeUInt32LE(payload.length, 8);
  sizes.writeUInt32LE(2, 12);
  return Buffer.concat([init.subarray(0, 9), sizes.subarray(0, 8), json, sizes.subarray(8), zstd]);
};

// a wavetable file: float32 mono at 44.1 kHz, frames of 2048 samples, its mark (clm chunk)
// `<!>2048 <flags> …`
export const writeTable = (file, frames, flags) => {
  const chunk = (id, body) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(3, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(44100, 4);
  fmt.writeUInt32LE(44100 * 4, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(32, 14);
  const data = Buffer.alloc(frames.length * 2048 * 4);
  frames.forEach((frame, k) => frame.forEach((value, i) => data.writeFloatLE(value, (k * 2048 + i) * 4)));
  const body = Buffer.concat([
    Buffer.from('WAVE'),
    chunk('fmt ', fmt),
    chunk('clm ', Buffer.from(`<!>2048 ${flags} wavetable`, 'latin1')),
    chunk('data', data),
  ]);
  writeFileSync(file, chunk('RIFF', body));
};

// a sample of the noise oscillator: float32 at 44.1 kHz, one or two channels (interleaved), no mark
export const writeSample = (file, channels) => {
  const n = channels.length;
  const frames = channels[0].length;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + frames * n * 4, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(3, 20);
  head.writeUInt16LE(n, 22);
  head.writeUInt32LE(44100, 24);
  head.writeUInt32LE(44100 * n * 4, 28);
  head.writeUInt16LE(n * 4, 32);
  head.writeUInt16LE(32, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(frames * n * 4, 40);
  const data = Buffer.alloc(frames * n * 4);
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < n; c++) data.writeFloatLE(channels[c][f], (f * n + c) * 4);
  writeFileSync(file, Buffer.concat([head, data]));
};
