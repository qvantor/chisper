// how many times the worklet module `name` was added (assets/worklets/<name>.js): the synth core adds the chain
// and the wavetable oscillator
export const workletLoads = (addModule: jest.Mock, name: string) =>
  addModule.mock.calls.filter(([url]) => /\/([^/]+?)\.js$/.exec(String(url))?.[1] === name).length;
