import { fromEvent, merge } from 'rxjs';
import { PrimitiveBS, rxModel, rxModelReact } from '@chisper/rxjs-react';
import { underrunEvents, watchDropouts } from '../latency/dropouts';
import { keepNormalLatency, LATENCY_HINTS, readLatencyMode, resolveLatency } from '../latency/latency';
import { createChain } from '../chain/chain';
import { LIMITER_STAGE } from '../chain/chain-params';
import { createWavetableEngine, WavetableEngineDependencies } from '../wavetable/wavetable-engine';

// browsers (iOS Safari especially) keep the context suspended until a user gesture,
// and iOS suspends/interrupts it again when the page goes to the background
const resumeOnGesture = (audioCtx: AudioContext) =>
  merge(
    fromEvent(document, 'pointerdown'),
    fromEvent(document, 'touchend'),
    fromEvent(document, 'keydown'),
    fromEvent(document, 'visibilitychange')
  ).subscribe(() => {
    if (document.visibilityState !== 'visible' || audioCtx.state === 'running') return;
    // play through the iOS silent switch (Safari 16.4+)
    const { audioSession } = navigator as Navigator & { audioSession?: { type: string } };
    if (audioSession) audioSession.type = 'playback';
    audioCtx.resume().catch(() => undefined);
  });

interface Dependencies {
  wavetables?: WavetableEngineDependencies;
}

export const synthCore = ({ wavetables: wavetableDependencies }: Dependencies = {}) =>
  rxModel(() => {
    // null: the browser picks its own (latency.ts)
    const latency = resolveLatency();
    const audioCtx = new AudioContext(latency ? { latencyHint: LATENCY_HINTS[latency] } : undefined);
    // everything after the voices in one worklet node with one core: the fx chain (its slots are told by the fx
    // model; the filter is in each voice), the master gain and the limiter, the last stage. The analysers tap its
    // output, they show what is played; until it has loaded the master is silent
    const chain = createChain(audioCtx);
    const { input, output } = chain;
    // the master limiter of the chain: its status (failed: the module, or the limiter itself in the core)
    const masterLimiter = { $status: chain.status(LIMITER_STAGE) };
    // the oscillators of every voice (an audio worklet, one node into the chain), loaded at the start like it
    const wavetables = createWavetableEngine(audioCtx, input, wavetableDependencies);

    output.connect(audioCtx.destination);

    const $masterGain = new PrimitiveBS<number>(1);
    // at low latency: the dropouts of the context so far (null: at normal, or the browser counts none), and
    // whether there were too many for this machine (the settings offer normal then)
    const $dropouts = new PrimitiveBS<number | null>(latency === 'low' ? underrunEvents(audioCtx) : null);
    const $dropoutWarning = new PrimitiveBS<boolean>(false);
    // the output silenced by a preset switch, from its mute to its unmute
    const $muted = new PrimitiveBS<boolean>(false);

    return {
      audioCtx,
      $dropouts,
      $dropoutWarning,
      $muted,
      chain,
      input,
      masterLimiter,
      output,
      wavetables,
      $masterGain,
    };
  })
    .actions(({ $masterGain, $dropoutWarning, $muted, chain, wavetables }) => {
      return {
        setMasterGain: (value: number) => $masterGain.next(value),
        // a preset switch (soundSwitch) silences the output after the tails of the fx, before the limiter: it
        // fades out in `seconds` from now, then opens again at once
        mute: (seconds: number) => {
          chain.mute(seconds);
          $muted.next(true);
        },
        unmute: () => {
          chain.unmute();
          $muted.next(false);
        },
        // the user answered the warning (it isn't shown again)
        dismissDropoutWarning: () => $dropoutWarning.next(false),
        // loads again the oscillators and the chain that failed, makes its limiter again if it did (each only
        // then): one Retry brings the sound back when both did (the network down at the start)
        retryAudio: () => {
          wavetables.retry();
          chain.retry();
          chain.retryStage(LIMITER_STAGE);
        },
      };
    })
    .subscriptions(({ $masterGain, $dropouts, $dropoutWarning, $muted, audioCtx, chain }) => [
      resumeOnGesture(audioCtx),
      $masterGain.subscribe((value) => chain.setMasterGain(value)),
      // too many dropouts at low: auto keeps normal from the next start on (those of a preset switch aren't
      // counted)
      ...($dropouts.value === null
        ? []
        : [
            watchDropouts(
              audioCtx,
              $muted,
              (count) => $dropouts.next(count),
              () => {
                if (readLatencyMode() === 'auto') keepNormalLatency();
                $dropoutWarning.next(true);
              }
            ),
          ]),
    ])
    .destroy(({ chain, wavetables }) => {
      chain.destroy();
      wavetables.destroy();
    });

export const {
  ModelProvider: SynthCoreProvider,
  useModel: useSynthCore,
  Context: SynthCoreContext,
} = rxModelReact('synthCore', synthCore);

export type SynthCoreModule = ReturnType<typeof useSynthCore>;
