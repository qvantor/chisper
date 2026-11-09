import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import { MdKeyboard, MdTune } from 'react-icons/md';
import { PanelButton, TapeSwitch, theme } from '@chisper/ui-kit';
import { ABOUT_PATH, ABOUT_TITLE, HeaderSection } from '../../common/components';
import { PresetSection } from '../../presets';
import { MidiInput, SettingsButton } from '../settings';
import { MasterHandle } from '../synth/components';
import { CLIP_SCREEN, MOBILE_SCREENS, SYNTH_SCREENS, SynthScreen } from '../screens';

export type MobileMode = 'synth' | 'keys';

// full-height sections like on desktop: logo | tabs | preset | mode | master;
// portrait: logo, CLIP and mode on top, OSC/FX and preset below, master through both rows
const Root = styled.div`
  border-bottom: 1px solid ${theme.colors.primaryLowContrast};
  display: grid;
  // mode keys get a share of the width, they never size by their labels
  grid-template-columns: auto auto minmax(0, 1fr) minmax(0, 200px) auto;
  grid-template-rows: 48px;
  grid-template-areas: 'logo tabs presets mode master';

  &.portrait {
    // CLIP right of the logo, where the top row has room: three keys under it would leave the name of the
    // preset a letter; mode takes the rest of the top row
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    grid-template-rows: 40px 50px;
    grid-template-areas:
      'logo clip mode master'
      'tabs presets presets master';
  }
`;

const Logo = styled.a`
  grid-area: logo;
  align-self: center;
  padding: 0 10px;
  text-decoration: none;
  font-size: 18px;
  font-weight: 700;
  background: -webkit-linear-gradient(45deg, ${theme.colors.secondAccent}, ${theme.colors.accent} 80%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
`;

const Tabs = styled.div`
  grid-area: tabs;
  display: flex;
  --tape-key-width: 52px;
  --tape-key-padding: 8px 0 10px;

  // the line under the portrait top row
  .portrait > & {
    --tape-key-padding: 7px 0 9px;
    border-top: 1px solid ${theme.colors.primaryLowContrast};
  }
`;

// the key of the clip on its own in the portrait top row, lower: a slot of its own
const ClipTab = styled.div`
  grid-area: clip;
  display: flex;
  --tape-key-width: 52px;
  --tape-key-padding: 5px 0 6px;
`;

// the tape switch's dark groove already separates it from the tabs
const Presets = styled(PresetSection)`
  grid-area: presets;

  .portrait > & {
    border-top: 1px solid ${theme.colors.primaryLowContrast};
  }
`;

// a strip of keys like the preset section's Save / Share row
const Mode = styled(HeaderSection)`
  grid-area: mode;
  align-items: stretch;
  gap: 1px;
  background: ${theme.colors.primaryLowContrast};
`;

const Master = styled(HeaderSection)`
  grid-area: master;
  padding: 0 10px;
`;

const modeOptions: { label: string; value: MobileMode; icon: React.ReactNode }[] = [
  { label: 'Synth', value: 'synth', icon: <MdTune /> },
  { label: 'Keys', value: 'keys', icon: <MdKeyboard /> },
];

interface Props {
  portrait: boolean;
  mode: MobileMode;
  onModeChange: (mode: MobileMode) => void;
  screen: SynthScreen;
  onScreenChange: (screen: SynthScreen) => void;
}

export const MobileHeader = ({ portrait, mode, onModeChange, screen, onScreenChange }: Props) => (
  <Root className={cls({ portrait })}>
    <Logo href={ABOUT_PATH} target='_blank' rel='noopener' title={ABOUT_TITLE}>
      CHISPER
    </Logo>
    {portrait && (
      <ClipTab>
        <TapeSwitch options={[CLIP_SCREEN]} value={screen} onChange={onScreenChange} switchOnDrag />
      </ClipTab>
    )}
    <Tabs>
      <TapeSwitch
        options={portrait ? SYNTH_SCREENS : MOBILE_SCREENS}
        value={screen}
        onChange={onScreenChange}
        switchOnDrag
      />
    </Tabs>
    <Presets
      actions={
        <>
          <MidiInput />
          <SettingsButton />
        </>
      }
    />
    <Mode>
      {modeOptions.map(({ label, value, icon }) => (
        <PanelButton
          key={value}
          icon={icon}
          active={mode === value}
          aria-pressed={mode === value}
          onClick={() => onModeChange(value)}
        >
          {label}
        </PanelButton>
      ))}
    </Mode>
    <Master>
      <MasterHandle label={null} />
    </Master>
  </Root>
);
