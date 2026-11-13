// a stereo core as the specs render it: through its facade, block by block

const BLOCK = 128;

export interface FxChange<Params> {
  // the frame of the block it is set before
  at: number;
  params?: Partial<Params>;
  clear?: boolean;
}

interface Dsp<Params> {
  process: (inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array) => void;
  set: (params: Partial<Params>) => void;
  clear: () => void;
  free: () => void;
  readonly idle: boolean;
}

// both channels through `dsp` in blocks of 128, then it is freed: the outputs, whether it was idle after each block
// (`after`: called then)
export const renderStereo = <Params>(
  dsp: Dsp<Params>,
  [left, right]: [ArrayLike<number>, ArrayLike<number>],
  changes: FxChange<Params>[] = [],
  after: () => void = () => undefined
) => {
  const frames = left.length;
  const [inL, inR] = [Float32Array.from(left), Float32Array.from(right)];
  const [outL, outR] = [new Float32Array(frames), new Float32Array(frames)];
  const idle: boolean[] = [];
  for (let start = 0; start < frames; start += BLOCK) {
    const end = Math.min(start + BLOCK, frames);
    changes
      .filter(({ at }) => at >= start && at < start + BLOCK)
      .forEach((change) => {
        if (change.params) dsp.set(change.params);
        if (change.clear) dsp.clear();
      });
    dsp.process(
      inL.subarray(start, end),
      inR.subarray(start, end),
      outL.subarray(start, end),
      outR.subarray(start, end)
    );
    idle.push(dsp.idle);
    after();
  }
  dsp.free();
  return { left: outL, right: outR, idle };
};
