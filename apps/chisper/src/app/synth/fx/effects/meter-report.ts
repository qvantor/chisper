// The meter of an effect on the audio thread: what its worklet posts of its core while a screen watches it. No
// window, document or React here (a worklet module imports it)

// about this many messages a second while it is watched
export const METER_RATE = 30;

// `metering`: someone watches; `waited`: the frames since the last message (nothing is read off the core while no
// one watches); `rested`: the meter of a core at rest was posted, nothing moves until a sound
export interface Metered {
  metering: boolean;
  waited: number;
  rested: boolean;
}

export const metered = (metering: boolean): Metered => ({ metering, waited: 0, rested: false });

// a watcher came (the next message is the meter as it is, at rest too) or the last one left
export const watchMeter = (state: Metered, metering: boolean) => {
  state.metering = metering;
  state.waited = 0;
  state.rested = false;
};

// after a block of `frames`: whether a message is due now. A core at rest (`idle`) is posted once
export const meterDue = (state: Metered & { readonly idle: boolean }, frames: number, sampleRate: number) => {
  if (!state.metering) return false;
  state.waited += frames;
  if (state.waited < sampleRate / METER_RATE) return false;
  state.waited = 0;
  const { idle } = state;
  if (idle && state.rested) return false;
  state.rested = idle;
  return true;
};
