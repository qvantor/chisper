import React from 'react';
import { combineLatest, distinctUntilChanged, map, NEVER, type BehaviorSubject } from 'rxjs';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import toast from 'react-hot-toast';
import { Tooltip } from 'antd';
import { MdOutlineAudioFile } from 'react-icons/md';
import { LoadProgress, text10, textBold12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject, useObservable } from '@chisper/rxjs-react';
import { CLIP_PPQ, type Clip } from '@chisper/preset-schema';
import {
  Bar,
  Choice,
  ChoiceKeys,
  Dialog,
  DialogIntro,
  GroupLabel,
  Key,
  PopoverGroup,
  PopoverNote,
  Spacer,
} from '../../../common/components';
import { isChunkGone, readStored, saveFile, UPDATED, writeStored } from '../../../common/services';
import { captureError, errorMessage, featureUsed, track } from '../../../common/services/analytics';
import { PresetsContext } from '../../../presets';
import { presetUrl, synthUrl } from '../../../presets/services';
import type { NoiseModel, OscillatorModel } from '../../common/modules';
import { NoiseContext } from '../../common/modules/noise';
import { Oscillator1Context, Oscillator2Context } from '../../common/modules/oscillator';
import { SynthCoreContext } from '../../common/modules/synth-core';
import { TransportContext, type TempoSource } from '../../common/modules/transport';
import { wavBytes, type WavFormat } from '../../services/wav-writer';
import type { WavetableStatus } from '../../common/wavetable/wavetable-engine';
import { pageSound, soundLoading } from '../export/page-sound';
import type { ClipLevel, ClipSpan } from '../export/render-clip';
import { bpmLabel, wavTagChunks, type WavTags } from '../export/wav-tags';
import { safeFileName } from '../midi-file';
import { lengthLabel } from '../track-edit';
import { useTrack } from '../modules/track';
import { ClipIcon, HeadroomIcon, LimitedIcon, LoopIcon, TailIcon } from './export-icons';
import { DownloadIcon, Ext } from './header-icons';
import { rollTempo } from './tempo-display';

const { colors } = theme;

interface Options {
  format: WavFormat;
  sampleRate: number;
  span: ClipSpan;
  level: ClipLevel;
}

// a key of a number: the number large, its unit small under it
const Value = styled.span`
  font-size: 14px;
  line-height: 14px;
  letter-spacing: 0.5px;
`;

const Unit = styled.span`
  ${text10};
  font-size: 9px;
  line-height: 9px;
  opacity: 0.7;
`;

const numberKey = (value: string, unit: string) => (
  <>
    <Value>{value}</Value>
    <Unit>{unit}</Unit>
  </>
);

// a key of an icon and its label
const iconKey = (Icon: React.ComponentType, label: string) => (
  <>
    <Icon />
    {label}
  </>
);

const FORMATS: Choice<WavFormat>[] = [
  { value: 'pcm16', label: numberKey('16', 'bit'), name: '16-bit' },
  { value: 'pcm24', label: numberKey('24', 'bit'), name: '24-bit' },
  { value: 'float32', label: numberKey('32', 'float'), name: '32-bit float' },
];
const RATES: Choice<number>[] = [
  { value: 44100, label: numberKey('44.1', 'kHz'), name: '44.1 kHz' },
  { value: 48000, label: numberKey('48', 'kHz'), name: '48 kHz' },
];
const SPANS: Choice<ClipSpan>[] = [
  { value: 'clip', label: iconKey(ClipIcon, 'Clip') },
  { value: 'tail', label: iconKey(TailIcon, 'Clip + tail') },
  { value: 'loop', label: iconKey(LoopIcon, 'Seamless loop') },
];
const SPAN_NOTES: Record<ClipSpan, string> = {
  clip: 'Clip length, its end faded out: loops anywhere.',
  tail: 'The clip once, then what sounds after it.',
  loop: 'Clip length, its tail sounding into its start.',
};

const LEVELS: Choice<ClipLevel>[] = [
  { value: 'played', label: iconKey(LimitedIcon, 'As played') },
  { value: 'headroom', label: iconKey(HeadroomIcon, 'Headroom') },
];
const LEVEL_NOTES: Record<ClipLevel, string> = {
  played: 'Through the limiter, as loud as it plays.',
  headroom: 'No limiter: turned down as a whole if too loud.',
};

// the choices by default: the format of a CD (16 bits at 44.1 kHz, what any player takes), the clip alone (its loop
// point in silence, no click in any player), as loud as it plays
const DEFAULTS: Options = { format: 'pcm16', sampleRate: 44100, span: 'clip', level: 'played' };

// the choices of the last export, kept in the browser
const STORED_KEY = 'exportWav';

// what is stored under the key: anything, its fields checked one by one
type Stored = Partial<Record<keyof Options, unknown>>;
const isObject = (value: unknown): value is Stored => typeof value === 'object' && value !== null;

// one of the choices of a group (the value stored, else the default)
const oneOf = <T,>(choices: Choice<T>[], value: unknown, initial: T): T =>
  choices.find((choice) => choice.value === value)?.value ?? initial;

// the choices stored, each one checked on its own (a stale or edited one is its default; none stored, or site data
// blocked: the defaults)
const readOptions = (): Options => {
  const stored = readStored('localStorage', STORED_KEY, {}, isObject);
  return {
    format: oneOf(FORMATS, stored.format, DEFAULTS.format),
    sampleRate: oneOf(RATES, stored.sampleRate, DEFAULTS.sampleRate),
    span: oneOf(SPANS, stored.span, DEFAULTS.span),
    level: oneOf(LEVELS, stored.level, DEFAULTS.level),
  };
};

// the label of the file it saves: white, as a label on a tape, its name on it
const FileLabel = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px 0 8px;
  border-radius: 3px;
  background: ${colors.white};
  box-shadow: inset 0 0 0 1px ${colors.primaryLowContrast};

  svg {
    flex: none;
    font-size: 17px;
    color: ${colors.secondAccent};
  }
`;

const FileText = styled.span`
  ${textBold12};
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${colors.primaryDarkMediumContrast};
`;

// the length of the clip, the duration of the file, its size: one quiet line under its label, on the light of the
// dialog (wrapped on a phone)
const Facts = styled.dl`
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  margin: -2px 0 0;
  padding: 0 3px;
`;

// the label, the value after it: one size (the capitals of the label as high as the digits of the value), the label
// lighter
const Fact = styled.div`
  display: flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
  font-size: 10px;
  line-height: 12px;

  dt {
    font-weight: 600;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    color: ${colors.primaryMediumContrast};
  }

  dd {
    margin: 0;
    font-weight: 600;
    color: ${colors.primaryHighContrast};
    font-variant-numeric: tabular-nums;
  }
`;

// what a value leaves out (the tail, known once rendered)
const Plus = styled.span`
  font-weight: 400;
  color: ${colors.primaryMediumContrast};
`;

// the choices on the light of the dialog, in groups as those of the settings
const Panel = styled.div`
  display: flex;
  flex-direction: column;
`;

// the format and the rate side by side
const Pair = styled(PopoverGroup)`
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 7px 10px;
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
`;

// keys of a number over its unit
const NumberKeys = styled.div`
  & [role='radio'] {
    height: 38px;
    gap: 3px;
  }
`;

// keys of an icon over a label (wrapped on a phone)
const IconKeys = styled.div`
  & [role='radio'] {
    height: auto;
    min-height: 48px;
    padding: 7px 4px 6px;
    gap: 5px;
    line-height: 12px;
    white-space: normal;
    text-align: center;
  }
`;

// keys of an icon beside a label
const RowKeys = styled.div`
  & [role='radio'] {
    height: 34px;
    flex-direction: row;
    gap: 8px;
  }
`;

// the progress of a render in the bar of the keys: a track (a canvas in it), its percent
const Meter = styled.div`
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 10px;
`;

const Track = styled.div`
  flex: 1 1 0;
  position: relative;
  height: 8px;
  overflow: hidden;
  border-radius: 4px;
  background: ${hexToRgba(colors.primaryDark, 0.16)};
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 20%);
`;

const Percent = styled.span`
  flex: none;
  min-width: 4ch;
  text-align: right;
  font-variant-numeric: tabular-nums;
`;

// steps of the progress shown (a render tells it every block)
const STEP = 0.01;

// the title of the file: the preset and the clip (Pad - Riff; one of them where the other has no name or both have
// the one name), else Chisper
export const wavTitle = (clip: Pick<Clip, 'name'>, preset: string | null) => {
  const presetName = preset?.trim() ?? '';
  const clipName = clip.name?.trim() ?? '';
  return [presetName, clipName === presetName ? '' : clipName].filter(Boolean).join(' - ') || 'Chisper';
};

// the name of the file: its title, the tempo
export const wavFileName = (clip: Pick<Clip, 'name'>, preset: string | null, bpm: number) =>
  `${safeFileName(wavTitle(clip, preset))} ${bpmLabel(bpm)}.wav`;

// the preset playing (none: Init, or no presets)
type Preset = { id: string; name: string } | null;

// what the tags of the file tell: its title, the preset and its link where the sound is that preset as saved (not
// changed since: `dirty` false), the link of the synth, the time now
const wavTagsOf = (clip: Pick<Clip, 'name'>, preset: Preset, dirty: boolean): WavTags => ({
  title: wavTitle(clip, preset?.name ?? null),
  preset: preset && !dirty ? { name: preset.name, url: presetUrl(preset.id) } : null,
  synthUrl: synthUrl(),
  date: new Date(),
});

// seconds as a file's duration: 9.85 s, 1:02.50
export const durationLabel = (seconds: number) => {
  // (rounded first: 59.996 is 1:00.00)
  const shown = Number(seconds.toFixed(2));
  const minutes = Math.floor(shown / 60);
  if (minutes === 0) return `${shown.toFixed(2)} s`;
  return `${minutes}:${(shown - minutes * 60).toFixed(2).padStart(5, '0')}`;
};

// bytes as a file's size, as the Finder tells it: 640 KB, 2.3 MB
export const sizeLabel = (bytes: number) =>
  bytes < 999_500 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;

// the tempo of the transport of the page: its field, the one in effect, whether a MIDI Clock leads it
interface PageTempo {
  $bpm: BehaviorSubject<number>;
  $tempo: BehaviorSubject<number>;
  $source: BehaviorSubject<TempoSource>;
}

// the tempo an export plays at: the one the piano roll shows (under a MIDI Clock its tempo, not the field's)
const tempoNow = ({ $bpm, $tempo, $source }: PageTempo) => rollTempo($source.value, $bpm.value, $tempo.value);
const useTempoNow = ({ $bpm, $tempo, $source }: PageTempo) => {
  const $now = React.useMemo(
    () =>
      combineLatest([$source, $bpm, $tempo]).pipe(
        map(([source, bpm, tempo]) => rollTempo(source, bpm, tempo)),
        distinctUntilChanged()
      ),
    [$bpm, $tempo, $source]
  );
  return useObservable($now, tempoNow({ $bpm, $tempo, $source }));
};

// the models of the page whose sound an export plays
interface PageModels extends PageTempo {
  oscillators: [OscillatorModel, OscillatorModel];
  noise: NoiseModel;
  // the Master of the page
  $masterGain: BehaviorSubject<number>;
}

// the file an export saves as it is now (the clip, the preset, the tempo, the choices): its name, the length of the
// clip, the duration and the size of the file with its tags (as long as the clip; a tail's are of the clip alone,
// its tail known once rendered). Its props the same while a render goes on: not made again at each step of its progress
const FileInfo = React.memo(({ $bpm, $tempo, $source, options }: PageTempo & { options: Options }) => {
  const [{ $clip }] = useTrack();
  const clip = useBehaviorSubject($clip);
  const bpm = useTempoNow({ $bpm, $tempo, $source });
  const presets = React.useContext(PresetsContext);
  const $preset = presets?.[0].$current;
  const $dirty = presets?.[0].$dirty;
  const preset = useObservable<Preset>($preset ?? NEVER, $preset?.value ?? null);
  const dirty = useObservable<boolean>($dirty ?? NEVER, $dirty?.value ?? false);
  const name = wavFileName(clip, preset?.name ?? null, bpm);
  const beats = clip.length / CLIP_PPQ;
  const seconds = (beats * 60) / bpm;
  const { format, sampleRate, span } = options;
  const frames = Math.round(seconds * sampleRate);
  const tags = wavTagChunks(wavTagsOf(clip, preset, dirty), { bpm, beats, span, sampleRate, frames });
  const tail = span === 'tail' && <Plus> + tail</Plus>;
  return (
    <>
      <FileLabel title={name}>
        <MdOutlineAudioFile aria-hidden />
        <FileText>{name}</FileText>
      </FileLabel>
      <Facts>
        <Fact>
          <dt>Clip</dt>
          <dd>{lengthLabel(clip.length)}</dd>
        </Fact>
        <Fact>
          <dt>Duration</dt>
          <dd>
            {durationLabel(seconds)}
            {tail}
          </dd>
        </Fact>
        <Fact>
          <dt>Size</dt>
          <dd>
            {sizeLabel(wavBytes(format, frames, tags))}
            {tail}
          </dd>
        </Fact>
      </Facts>
    </>
  );
});

interface Props extends PageModels {
  open: boolean;
  onClose: () => void;
}

// The export of the clip as a .wav: the clip played by the sound of the page, rendered faster than it plays (the
// track stops meanwhile; the keys and the MIDI play on), the format, the rate and the length chosen; its progress,
// Cancel. The render is a module of its own, loaded at the first export
export const ExportWavDialog = ({
  open,
  onClose,
  oscillators,
  noise,
  $bpm,
  $tempo,
  $source,
  $masterGain,
}: Props) => {
  const [{ $clip }, { stop }] = useTrack();
  const presets = React.useContext(PresetsContext);
  const [options, setOptions] = React.useState<Options>(readOptions);
  const [progress, setProgress] = React.useState<number | null>(null);
  // the controller of the render of now (a cancelled one is none: it ends on its own, telling nothing)
  const abort = React.useRef<AbortController | null>(null);
  // (the dialog gone: its render too)
  React.useEffect(() => () => abort.current?.abort(), []);
  // as stored at each opening (the key of the export of a phone, another tab may have chosen meanwhile)
  React.useEffect(() => {
    if (open) setOptions(readOptions());
  }, [open]);
  const choose = (change: Partial<Options>) => {
    const next = { ...options, ...change };
    setOptions(next);
    writeStored('localStorage', STORED_KEY, next);
  };

  const start = async () => {
    if (soundLoading(oscillators, noise)) {
      toast.error('The sound is still loading: export it once it has loaded');
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setProgress(0);
    stop();
    const clip = $clip.value;
    const bpm = tempoNow({ $bpm, $tempo, $source });
    const preset = presets?.[0].$current.value ?? null;
    const dirty = presets?.[0].$dirty.value ?? false;
    const tags = wavTagsOf(clip, preset, dirty);
    // the sound of the click, as its name and its tags (a preset applied while the chunk of the render loads is not
    // in it: its knobs on the tables of the one before)
    const sound = pageSound(oscillators, noise, bpm, $masterGain.value);
    let shown = 0;
    try {
      const { exportWav } = await import('../export');
      const blob = await exportWav(
        sound,
        { notes: clip.notes, length: clip.length },
        {
          format: options.format,
          sampleRate: options.sampleRate,
          span: options.span,
          level: options.level,
          tags,
          signal: controller.signal,
          onProgress: (share) => {
            if (controller.signal.aborted || (share - shown < STEP && share < 1)) return;
            shown = share;
            setProgress(share);
          },
        }
      );
      controller.signal.throwIfAborted();
      saveFile(blob, wavFileName(clip, preset?.name ?? null, bpm));
      track('wav_export', {
        ...options,
        seconds: Math.round((clip.length / CLIP_PPQ) * (60 / bpm)),
        // (a public preset as it was saved: its id is in its link)
        preset: preset && !dirty ? preset.id : null,
      });
      featureUsed('export', 'wav');
      onClose();
    } catch (error) {
      if (!controller.signal.aborted) {
        // (the chunk of the render gone: a page of before a deploy)
        const gone = isChunkGone(error);
        toast.error(gone ? UPDATED : error instanceof Error ? error.message : 'The export failed');
        // reported once, here (the engine of a render reports nothing itself: engine-host.ts)
        if (!gone)
          captureError(error, {
            source: 'engine',
            kind: 'render',
            fingerprint: `engine:render:${errorMessage(error).slice(0, 100)}`,
          });
      }
    } finally {
      // (a cancelled one: the dialog was free at once, maybe rendering anew)
      if (abort.current === controller) {
        abort.current = null;
        setProgress(null);
      }
    }
  };
  // the render stopped, the dialog free at once (the render ends on its own: the download of the core it waits for,
  // the slice it is in)
  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setProgress(null);
    onClose();
  };
  const rendering = progress !== null;
  const percent = rendering ? Math.round(progress * 100) : 0;
  // the keys of a choice (none takes focus: the dialog is focusless), off while a render goes on: they show the
  // choices of the file it makes
  const keys = <K extends keyof Options>(label: string, field: K, choices: Choice<Options[K]>[]) => (
    <ChoiceKeys
      aria-label={label}
      options={choices}
      value={options[field]}
      onChange={(value) => choose({ [field]: value })}
      focusable={false}
      disabled={rendering}
    />
  );

  return (
    <Dialog title='Export WAV' open={open} onCancel={cancel} width={400} destroyOnHidden focusless>
      <DialogIntro>The clip played by the sound as it is now, at the tempo of the piano roll.</DialogIntro>
      <FileInfo $bpm={$bpm} $tempo={$tempo} $source={$source} options={options} />
      <Panel data-testid='export-wav'>
        <Pair>
          <Field>
            <GroupLabel>Format</GroupLabel>
            <NumberKeys>{keys('Format', 'format', FORMATS)}</NumberKeys>
          </Field>
          <Field>
            <GroupLabel>Sample rate</GroupLabel>
            <NumberKeys>{keys('Sample rate', 'sampleRate', RATES)}</NumberKeys>
          </Field>
        </Pair>
        <PopoverGroup>
          <GroupLabel>Length</GroupLabel>
          <IconKeys>{keys('Length', 'span', SPANS)}</IconKeys>
          <PopoverNote>{SPAN_NOTES[options.span]}</PopoverNote>
        </PopoverGroup>
        <PopoverGroup>
          <GroupLabel>Level</GroupLabel>
          <RowKeys>{keys('Level', 'level', LEVELS)}</RowKeys>
          <PopoverNote>{LEVEL_NOTES[options.level]}</PopoverNote>
        </PopoverGroup>
      </Panel>
      <Bar>
        {rendering ? (
          <Meter>
            <Track role='progressbar' aria-label='Rendering' aria-valuenow={percent}>
              <LoadProgress progress={progress} look='fill' color={colors.accent} />
            </Track>
            <Percent>{percent}%</Percent>
          </Meter>
        ) : (
          <Spacer />
        )}
        <Key tabIndex={-1} onClick={cancel}>
          Cancel
        </Key>
        <Key tabIndex={-1} disabled={rendering} onClick={start}>
          <DownloadIcon />
          {rendering ? 'Rendering…' : 'Export'}
        </Key>
      </Bar>
    </Dialog>
  );
};

// a key that tells why it can't export (a tooltip over a disabled key needs a wrapper)
const KeyTip = ({ tip, children }: React.PropsWithChildren<{ tip: string }>) => (
  <Tooltip title={tip}>
    <span>{children}</span>
  </Tooltip>
);

// the key of the export and its dialog: off while the clip has no notes or the synth doesn't play (the status of
// the voices of the page)
const ExportWavControls = ({
  compact,
  $status,
  ...models
}: PageModels & { compact: boolean; $status: BehaviorSubject<WavetableStatus> }) => {
  const [{ $clip }] = useTrack();
  const ready = useBehaviorSubject($status) === 'ready';
  const empty = useBehaviorSubject($clip).notes.length === 0;
  const [open, setOpen] = React.useState(false);
  const why = empty ? 'The clip has no notes' : !ready ? 'The synth does not play here' : null;
  return (
    <>
      <KeyTip tip={why ?? 'Export a .wav: the clip played by the sound, alone, with its tail or as a loop'}>
        <Key
          aria-label='Export WAV'
          className={compact ? 'square' : undefined}
          disabled={why !== null}
          onClick={() => setOpen(true)}
        >
          <DownloadIcon />
          {!compact && <Ext>.wav</Ext>}
        </Key>
      </KeyTip>
      <ExportWavDialog open={open} onClose={() => setOpen(false)} {...models} />
    </>
  );
};

// the export of the clip as a .wav, where the models of the sound are there (outside the synth, a spec of the roll:
// nothing)
export const ExportWav = ({ compact = false }: { compact?: boolean }) => {
  const synthCore = React.useContext(SynthCoreContext);
  const osc1 = React.useContext(Oscillator1Context);
  const osc2 = React.useContext(Oscillator2Context);
  const noise = React.useContext(NoiseContext);
  const transport = React.useContext(TransportContext);
  if (!synthCore || !osc1 || !osc2 || !noise || !transport) return null;
  return (
    <ExportWavControls
      compact={compact}
      oscillators={[osc1[0], osc2[0]]}
      noise={noise[0]}
      $bpm={transport[0].$bpm}
      $tempo={transport[0].$tempo}
      $source={transport[0].$source}
      $masterGain={synthCore[0].$masterGain}
      $status={synthCore[0].wavetables.$status}
    />
  );
};
