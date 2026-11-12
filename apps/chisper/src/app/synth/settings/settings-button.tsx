import { useEffect, useState } from 'react';
import { MdSettings } from 'react-icons/md';
import cls from 'classnames';
import { styled } from 'styled-components';
import { PanelButton, text10, text12, textBold12, theme } from '@chisper/ui-kit';
import toast from 'react-hot-toast';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import {
  Choice,
  ChoiceKeys,
  GroupLabel,
  Key,
  PopoverGroup,
  PopoverNote,
  SectionPopover,
  ToastAsk,
} from '../../common/components';
import { useSynthCore } from '../common/modules';
import { canCountDropouts } from '../common/latency/dropouts';
import {
  autoLatency,
  canChooseLatency,
  canKeepLatency,
  Latency,
  LatencyMode,
  readLatencyMode,
  reloadPage,
  setLatencyMode,
  switchToNormalLatency,
} from '../common/latency/latency';
import { ManualLink } from './manual-link';

const { colors } = theme;

// two lines in a key: Auto over the latency it picked, both over the line of the key chosen
const LatencyKeys = styled.div`
  & [role='radio'] {
    height: 36px;
    padding-bottom: 5px;
  }
`;

const Picked = styled.span`
  ${text10};
  margin-top: 2px;
  font-size: 9px;
  letter-spacing: 0.8px;
  opacity: 0.75;
`;

const NoteButton = styled.button`
  margin-left: 4px;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: ${colors.secondAccent};
  text-decoration: underline;
  cursor: pointer;
`;

// a count of the section: its name on the left, the number on the right (red once there is one)
const Count = styled.div`
  ${text12};
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: ${colors.primaryHighContrast};
`;

const CountValue = styled.span`
  ${textBold12};
  margin-left: auto;
  color: ${colors.primaryDarkMediumContrast};
  font-variant-numeric: tabular-nums;

  &.some {
    color: ${colors.red};
  }
`;

// a square key of the icon alone, as ◀ ▶ of the presets above it
const GearButton = styled(PanelButton)`
  flex: 0 0 40px;
  gap: 0;
  padding: 0;
`;

const DROPOUT_TOAST = 'latency-dropouts';

const LATENCY_NAMES: Record<Latency, string> = { low: 'Low', normal: 'Normal' };

// Auto chosen shows the latency it picked under it: Auto (Low)
const latencyOptions = (mode: LatencyMode, auto: Latency): Choice<LatencyMode>[] => [
  mode === 'auto'
    ? {
        value: 'auto',
        label: (
          <>
            Auto<Picked>{LATENCY_NAMES[auto]}</Picked>
          </>
        ),
        name: `Auto (${LATENCY_NAMES[auto]})`,
      }
    : { value: 'auto', label: 'Auto' },
  { value: 'low', label: LATENCY_NAMES.low },
  { value: 'normal', label: LATENCY_NAMES.normal },
];

export const SettingsButton = () => {
  const [open, setOpen] = useState(false);
  const [{ $dropouts, $dropoutWarning }, { dismissDropoutWarning }] = useSynthCore();
  const dropouts = useBehaviorSubject($dropouts);
  const warning = useBehaviorSubject($dropoutWarning);
  // the mode stored: the context plays at the one it was created with until the reload
  const [mode] = useState(readLatencyMode);
  // the storage keeps a choice (a probe that writes: once)
  const [keeps] = useState(canKeepLatency);

  // too many dropouts at low latency: once, until the user answers it
  useEffect(() => {
    if (!warning) return;
    const answer = (switchNow: boolean) => {
      toast.dismiss(DROPOUT_TOAST);
      dismissDropoutWarning();
      if (switchNow) switchToNormalLatency();
    };
    toast(
      <ToastAsk text='The sound crackles. Switch to Normal for a steady sound?'>
        <Key onClick={() => answer(false)}>Not now</Key>
        <Key onClick={() => answer(true)}>Switch to Normal</Key>
      </ToastAsk>,
      { id: DROPOUT_TOAST, duration: Infinity }
    );
  }, [warning, dismissDropoutWarning]);

  const changeMode = (next: LatencyMode) => {
    setLatencyMode(next);
    reloadPage();
  };

  // where the browser counts no dropouts nothing warns of them and auto stays normal (latency.ts)
  const counts = canCountDropouts();
  // what auto has learnt (after dropouts in this session it differs from the latency playing); its key, the one
  // chosen, would change nothing, so a key of the note forgets it
  const auto = autoLatency();
  const learntNormal = mode === 'auto' && counts && auto === 'normal';
  // short, in the words of what is heard: the response of the keys and a crackle; the keys name the latency
  const note = () => {
    if (mode === 'low')
      return counts
        ? 'Faster response, may crackle on a slow computer.'
        : 'Faster response. If the sound crackles, choose Normal.';
    if (mode === 'normal') return 'Slightly slower response, steady sound.';
    if (!counts) return 'Always Normal in this browser.';
    return learntNormal ? 'Low crackled on this computer.' : 'Switches to Normal if the sound crackles.';
  };

  const latencyField = () => {
    if (!canChooseLatency()) return <PopoverNote>This browser sets the latency itself.</PopoverNote>;
    if (!keeps) return <PopoverNote>Normal: site data is blocked, a choice would not be kept.</PopoverNote>;
    return (
      <>
        {/* a key a choice: a step through Low on the way to Normal would be a reload */}
        <LatencyKeys>
          <ChoiceKeys
            aria-label='Latency'
            value={mode}
            options={latencyOptions(mode, auto)}
            onChange={changeMode}
          />
        </LatencyKeys>
        <PopoverNote>
          {note()}
          {learntNormal && <NoteButton onClick={() => changeMode('auto')}>Try low again</NoteButton>}
        </PopoverNote>
      </>
    );
  };

  return (
    <SectionPopover
      title='Settings'
      width={300}
      content={
        <>
          <PopoverGroup>
            <GroupLabel>Latency</GroupLabel>
            {latencyField()}
          </PopoverGroup>
          {dropouts !== null && (
            <PopoverGroup>
              <Count>
                Dropouts since the page opened
                <CountValue className={cls({ some: dropouts > 0 })}>{dropouts}</CountValue>
              </Count>
            </PopoverGroup>
          )}
          <PopoverGroup>
            <ManualLink />
          </PopoverGroup>
        </>
      }
      open={open}
      onOpenChange={setOpen}
    >
      <GearButton icon={<MdSettings />} active={open} aria-label='Settings' />
    </SectionPopover>
  );
};
