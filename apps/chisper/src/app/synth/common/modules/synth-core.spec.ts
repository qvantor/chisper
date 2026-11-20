import { registrar } from 'standardized-audio-context-mock';
import { createSynthCore, stopModels } from '../../../../test-utils/models';
import { withoutAudioWorklet } from '../../../../test-utils/no-audio-worklet';
import { setChromium, setPlaybackStats } from '../../../../test-utils/user-agent';
import { setVisibility } from '../../../../test-utils/visibility';
import { workletLoads } from '../../../../test-utils/worklet-loads';
import { ChainMessage, LIMITER_STAGE } from '../chain/chain-params';
import { ENGINE_PROCESSOR, EngineOptions, PROBED_NODE_OPTIONS } from '../engine/engine-params';
import { keepNormalLatency, readAutoLatency, setLatencyMode } from '../latency/latency';

interface NodeStub extends AudioWorkletNode {
  name: string;
  options: AudioWorkletNodeOptions;
  port: AudioWorkletNode['port'] & { postMessage: jest.Mock };
}

// the modules load asynchronously: the nodes exist after the pending promises settle
const flush = () => new Promise((resolve) => setTimeout(resolve));

const nodesOf = (audioCtx: AudioContext, name: string) =>
  (registrar.getAudioNodes(audioCtx as never, 'AudioWorkletNode' as never) as unknown as NodeStub[]).filter(
    (node) => node.name === name
  );

// the synth core and the node of its engine (once its module has loaded): what it was made with, what its chain is
// told (not the port of the worker of its store)
const setup = () => {
  const module = createSynthCore();
  const [{ audioCtx }] = module;
  const node = () => nodesOf(audioCtx, ENGINE_PROCESSOR).at(-1);
  const state = () => (node()?.options.processorOptions as EngineOptions | undefined)?.state;
  const messages = () =>
    (node()?.port.postMessage.mock.calls ?? [])
      .map(([message]) => message as ChainMessage)
      .filter((message) => !('port' in message));
  // a message of the processor
  const report = (data: unknown) => node()?.port.onmessage?.({ data } as MessageEvent);
  return { module, model: module[0], actions: module[1], audioCtx, node, state, messages, report };
};

// every context of a spec fails the first `count` loads of its modules (the network down at the start)
const failLoads = (count: number) => {
  const Original = globalThis.AudioContext;
  class Offline extends Original {
    constructor(options?: AudioContextOptions) {
      super(options);
      const addModule = this.audioWorklet.addModule as jest.Mock;
      for (let i = 0; i < count; i++) addModule.mockRejectedValueOnce(new Error('offline'));
    }
  }
  Object.assign(globalThis, { AudioContext: Offline });
  return () => Object.assign(globalThis, { AudioContext: Original });
};

describe('synthCore', () => {
  it('plays everything in one node: the engine → its output → destination', async () => {
    const { model, audioCtx, node } = setup();
    const { engine, output } = model;
    expect(output).toBe(engine.output);
    await flush();
    // the voices (the filter is in each), the effects, the master gain and the limiter: no other worklet node
    const nodes = registrar.getAudioNodes(audioCtx as never, 'AudioWorkletNode' as never);
    expect(nodes).toHaveLength(1);
    expect(nodesOf(audioCtx, ENGINE_PROCESSOR)).toHaveLength(1);
    // no input: nothing goes into it or around its limiter (the specs are a perf build: its second output is
    // the probe's)
    expect(node()?.options).toMatchObject(PROBED_NODE_OPTIONS);
    expect((node()?.connect as jest.Mock).mock.calls).toEqual([[output, 0]]);
    // the analysers tap what is played: the output of the engine, after its limiter
    expect((output.connect as jest.Mock).mock.calls[0]).toEqual([audioCtx.destination]);
  });

  it('is silent until the engine is ready: no node before its module has loaded', async () => {
    const { model, node } = setup();
    expect(node()).toBeUndefined();
    expect(model.chain.$status.value).toBe('loading');
    expect(model.wavetables.$status.value).toBe('loading');
    await flush();
    expect(node()?.connect).toHaveBeenCalledWith(model.output, 0);
    expect(model.chain.$status.value).toBe('ready');
    expect(model.wavetables.$status.value).toBe('ready');
  });

  it('the master volume starts at 0 dB, the output open', async () => {
    const { model, state, messages } = setup();
    expect(model.$masterGain.value).toBe(1);
    expect(model.$muted.value).toBe(false);
    await flush();
    expect(state()).toMatchObject({ masterGain: 1, muted: false });
    expect(messages()).toEqual([]);
  });

  it('destroys the chain, the wavetable oscillator and their node when it stops', async () => {
    const { model, node, messages } = setup();
    const destroy = jest.spyOn(model.chain, 'destroy');
    const destroyWavetables = jest.spyOn(model.wavetables, 'destroy');
    await flush();
    const stub = node();
    stopModels();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroyWavetables).toHaveBeenCalledTimes(1);
    // the processor ends, its core is freed (once: the node is the one of both)
    expect(messages()).toEqual([{ stop: true }]);
    [stub, model.output].forEach((item) => expect(item?.disconnect).toHaveBeenCalled());
  });

  it('stopped before the engine has loaded: no node is made', async () => {
    const { node } = setup();
    stopModels();
    await flush();
    expect(node()).toBeUndefined();
  });

  it('loads the one module of the engine at its start, once', async () => {
    const { model, audioCtx } = setup();
    const addModule = audioCtx.audioWorklet.addModule as jest.Mock;
    expect(workletLoads(addModule, 'engine')).toBe(1);
    expect(model.wavetables.$status.value).toBe('loading');
    await flush();
    expect(addModule).toHaveBeenCalledTimes(1);
  });

  describe('the master limiter', () => {
    it('is the last stage of the chain: its status that of the stage, loading then ready', async () => {
      const { model } = setup();
      expect(model.masterLimiter.$status).toBe(model.chain.status(LIMITER_STAGE));
      expect(model.masterLimiter.$status.value).toBe('loading');
      await flush();
      expect(model.masterLimiter.$status.value).toBe('ready');
    });

    it('fails alone when it traps in the core, retryAudio makes it again', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { model, actions, messages, report } = setup();
      await flush();
      report({ failed: [LIMITER_STAGE] });
      expect(model.masterLimiter.$status.value).toBe('failed');
      // the chain and its effects play on
      expect(model.chain.$status.value).toBe('ready');
      expect(model.chain.status(0).value).toBe('ready');
      actions.retryAudio();
      expect(messages()).toEqual([{ retry: LIMITER_STAGE }]);
      expect(model.masterLimiter.$status.value).toBe('loading');
      report({ remade: LIMITER_STAGE });
      expect(model.masterLimiter.$status.value).toBe('ready');
      error.mockRestore();
    });

    it('fails with the module of the engine, retryAudio loads it again: a new node with the knobs of now', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const restore = failLoads(1);
      const { model, actions, audioCtx, node, state } = setup();
      restore();
      await flush();
      expect(model.masterLimiter.$status.value).toBe('failed');
      expect(model.chain.$status.value).toBe('failed');
      // no fallback: nothing plays unlimited
      expect(node()).toBeUndefined();
      actions.setMasterGain(0.5);
      actions.retryAudio();
      expect(model.masterLimiter.$status.value).toBe('loading');
      await flush();
      expect(model.masterLimiter.$status.value).toBe('ready');
      expect(workletLoads(audioCtx.audioWorklet.addModule as jest.Mock, 'engine')).toBe(2);
      expect(node()?.connect).toHaveBeenCalledWith(model.output, 0);
      expect(state()?.masterGain).toBe(0.5);
      error.mockRestore();
    });

    it('without AudioWorklet it is unsupported: no node, the master silent', async () => {
      withoutAudioWorklet();
      const { model, actions, node } = setup();
      await flush();
      expect(model.masterLimiter.$status.value).toBe('unsupported');
      expect(node()).toBeUndefined();
      expect(() => {
        actions.setMasterGain(0.5);
        actions.mute(0.02);
        actions.unmute();
        actions.retryAudio();
      }).not.toThrow();
    });
  });

  // each only when it failed
  it('retryAudio loads the engine again, makes its limiter again', () => {
    const { model, actions } = setup();
    const retry = jest.spyOn(model.engine, 'retry');
    const retryStage = jest.spyOn(model.chain, 'retryStage');
    actions.retryAudio();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retryStage.mock.calls).toEqual([[LIMITER_STAGE]]);
  });

  it('retryAudio loads nothing again while nothing failed', async () => {
    const { actions, audioCtx, messages } = setup();
    await flush();
    actions.retryAudio();
    await flush();
    expect(audioCtx.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(nodesOf(audioCtx, ENGINE_PROCESSOR)).toHaveLength(1);
    expect(messages()).toEqual([]);
  });

  it('one retryAudio brings the chain and the oscillators back when the network was down at the start', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const restore = failLoads(1);
    const { model, actions, audioCtx } = setup();
    restore();
    await flush();
    expect(model.chain.$status.value).toBe('failed');
    expect(model.wavetables.$status.value).toBe('failed');
    actions.retryAudio();
    await flush();
    expect(model.chain.$status.value).toBe('ready');
    expect(model.wavetables.$status.value).toBe('ready');
    const addModule = audioCtx.audioWorklet.addModule as jest.Mock;
    expect(workletLoads(addModule, 'engine')).toBe(2);
    error.mockRestore();
  });

  it('setMasterGain tells the chain its master gain', async () => {
    const { model, actions, messages } = setup();
    const setMasterGain = jest.spyOn(model.chain, 'setMasterGain');
    await flush();
    actions.setMasterGain(0.3);
    expect(model.$masterGain.value).toBe(0.3);
    expect(setMasterGain).toHaveBeenLastCalledWith(0.3);
    // silence is a gain too
    actions.setMasterGain(0);
    expect(messages()).toEqual([{ masterGain: 0.3 }, { masterGain: 0 }]);
  });

  it('a master gain set before the chain has loaded: its node starts with it', async () => {
    const { actions, state, messages } = setup();
    actions.setMasterGain(0.3);
    await flush();
    expect(state()?.masterGain).toBe(0.3);
    expect(messages()).toEqual([]);
  });

  it('mute fades the output of the chain in its time, unmute opens it at once', async () => {
    const { model, actions, messages } = setup();
    await flush();
    actions.mute(0.02);
    expect(model.$muted.value).toBe(true);
    expect(messages()).toEqual([{ mute: 0.02, at: 0 }]);
    actions.unmute();
    expect(model.$muted.value).toBe(false);
    expect(messages()).toEqual([{ mute: 0.02, at: 0 }, { unmute: true }]);
  });

  it('muted before the chain has loaded: its node starts silent, opened again: open', async () => {
    const first = setup();
    first.actions.mute(0.02);
    await flush();
    expect(first.state()?.muted).toBe(true);
    const second = setup();
    second.actions.mute(0.02);
    second.actions.unmute();
    await flush();
    expect(second.state()?.muted).toBe(false);
  });

  it.each(['pointerdown', 'touchend', 'keydown', 'visibilitychange'])(
    'resumes a suspended context on %s',
    (type) => {
      const [{ audioCtx }] = createSynthCore();
      const resume = jest.spyOn(audioCtx, 'resume');
      expect(audioCtx.state).toBe('suspended');

      document.dispatchEvent(new Event(type));

      expect(resume).toHaveBeenCalledTimes(1);
      expect(audioCtx.state).toBe('running');
    }
  );

  it('does not resume a running context or a hidden page', () => {
    const [{ audioCtx }] = createSynthCore();
    const resume = jest.spyOn(audioCtx, 'resume');

    setVisibility('hidden');
    document.dispatchEvent(new Event('pointerdown'));
    expect(resume).not.toHaveBeenCalled();

    setVisibility('visible');
    document.dispatchEvent(new Event('pointerdown'));
    document.dispatchEvent(new Event('pointerdown'));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('switches the iOS audio session to playback before resuming', () => {
    const audioSession = { type: 'auto' };
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: audioSession });
    createSynthCore();
    document.dispatchEvent(new Event('pointerdown'));
    expect(audioSession.type).toBe('playback');
    delete (navigator as { audioSession?: unknown }).audioSession;
  });

  it('stops listening to gestures after stop', () => {
    const [{ audioCtx }] = createSynthCore();
    const resume = jest.spyOn(audioCtx, 'resume');
    stopModels();
    document.dispatchEvent(new Event('pointerdown'));
    expect(resume).not.toHaveBeenCalled();
  });

  describe('the latency', () => {
    // the options of the contexts created (the mock keeps none it shows)
    const created: (AudioContextOptions | undefined)[] = [];
    const Original = globalThis.AudioContext;
    // the count of dropouts the browser gives (playbackStats of Chrome)
    const stats = { underrunEvents: 0 };
    beforeEach(() => {
      created.length = 0;
      stats.underrunEvents = 0;
      class Recording extends Original {
        constructor(options?: AudioContextOptions) {
          super(options);
          created.push(options);
        }
      }
      Object.assign(globalThis, { AudioContext: Recording });
    });
    afterEach(() => {
      Object.assign(globalThis, { AudioContext: Original });
      jest.useRealTimers();
    });

    const withStats = () => setPlaybackStats({ underrunEvents: true, stats });
    // the browser refreshes its count, the core polls it a second later
    const dropout = () => {
      stats.underrunEvents++;
      jest.advanceTimersByTime(1000);
    };

    it('is left to a browser that ignores the hint', () => {
      const [{ $dropouts }] = createSynthCore();
      expect(created).toEqual([undefined]);
      expect($dropouts.value).toBeNull();
    });

    it('starts low in Chromium, normal once auto learnt it or chosen', () => {
      setChromium();
      createSynthCore();
      keepNormalLatency();
      createSynthCore();
      setLatencyMode('low');
      createSynthCore();
      setLatencyMode('normal');
      createSynthCore();
      expect(created).toEqual([
        { latencyHint: 0 },
        { latencyHint: 'interactive' },
        { latencyHint: 0 },
        { latencyHint: 'interactive' },
      ]);
    });

    it('is normal in auto where Chromium counts no dropouts, low chosen by hand', () => {
      setChromium({ countsDropouts: false });
      createSynthCore();
      setLatencyMode('low');
      const [{ $dropouts }] = createSynthCore();
      expect(created).toEqual([{ latencyHint: 'interactive' }, { latencyHint: 0 }]);
      expect($dropouts.value).toBeNull();
    });

    it('at low, warns of too many dropouts and auto keeps normal from the next start on', () => {
      setChromium();
      withStats();
      jest.useFakeTimers();
      const [{ $dropouts, $dropoutWarning }, { dismissDropoutWarning }] = createSynthCore();
      expect($dropouts.value).toBe(0);
      dropout();
      dropout();
      expect($dropouts.value).toBe(2);
      expect($dropoutWarning.value).toBe(false);
      expect(readAutoLatency()).toBe('low');
      dropout();
      expect($dropoutWarning.value).toBe(true);
      expect(readAutoLatency()).toBe('normal');
      dismissDropoutWarning();
      expect($dropoutWarning.value).toBe(false);
      dropout();
      expect($dropoutWarning.value).toBe(false);
    });

    it("at a low chosen by hand warns, the choice stays the user's", () => {
      setChromium();
      setLatencyMode('low');
      withStats();
      jest.useFakeTimers();
      const [{ $dropoutWarning }] = createSynthCore();
      dropout();
      dropout();
      dropout();
      expect($dropoutWarning.value).toBe(true);
      expect(readAutoLatency()).toBe('low');
    });

    it('does not count the dropouts of a preset switch: its work on the audio thread, the output silent', () => {
      setChromium();
      withStats();
      jest.useFakeTimers();
      const [{ $dropouts, $dropoutWarning }, { mute, unmute }] = createSynthCore();
      mute(0.02);
      dropout();
      dropout();
      unmute();
      // shown a second late
      dropout();
      expect($dropouts.value).toBe(3);
      dropout();
      dropout();
      expect($dropoutWarning.value).toBe(false);
      dropout();
      expect($dropoutWarning.value).toBe(true);
    });

    it('does not count dropouts at normal', () => {
      setChromium();
      setLatencyMode('normal');
      withStats();
      jest.useFakeTimers();
      const [{ $dropouts, $dropoutWarning }] = createSynthCore();
      expect($dropouts.value).toBeNull();
      dropout();
      dropout();
      dropout();
      expect($dropoutWarning.value).toBe(false);
    });
  });
});
