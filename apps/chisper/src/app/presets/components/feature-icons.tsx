import React from 'react';
import { styled } from 'styled-components';
import { Tooltip } from 'antd';
import { ICON_LINE, IconSvg as Icon, theme } from '@chisper/ui-kit';
import { FEATURE_LOOKS, PresetFeature } from '@chisper/preset-schema';

const { colors } = theme;

// icons of what a preset does, 16 × 16 in currentColor, as those of the keys of the synth

// its clip played: a play triangle
export const PlayIcon = () => (
  <Icon>
    <path d='M4.6 2.6v10.8l8.6-5.4z' />
  </Icon>
);

// its clip stopped
export const StopIcon = () => (
  <Icon>
    <rect x={3.5} y={3.5} width={9} height={9} rx={1.2} />
  </Icon>
);

// made with AI: the head of a robot (its antenna, its eyes, its ears)
const AiIcon = () => (
  <Icon>
    <g {...ICON_LINE}>
      <rect x={3} y={5.4} width={10} height={8.4} rx={2} />
      <path d='M8 5.4V3.4' />
      <path d='M1.2 8.4v2.6M14.8 8.4v2.6' />
    </g>
    <circle cx={8} cy={2.3} r={1.3} />
    <circle cx={6} cy={9.4} r={1.2} />
    <circle cx={10} cy={9.4} r={1.2} />
  </Icon>
);

// in BPM: a metronome
const TempoSyncIcon = () => (
  <Icon>
    <g {...ICON_LINE}>
      <path d='M5.6 1.8h4.8l2.6 12.4H3z' />
      <path d='M8 11.2l3.6-7.4' />
      <path d='M4.6 11.2h6.8' />
    </g>
  </Icon>
);

// one note at a time
const MonoIcon = () => (
  <Icon>
    <path d='M6.2 4.4L9.2 2h1.4v10.6h2v1.6H5.8v-1.6h2.9V4.6L6.9 5.9z' />
  </Icon>
);

// from note to note: a curve between two points
const GlideIcon = () => (
  <Icon>
    <path d='M3.2 12.4c4.4 0 5.2-8.8 9.6-8.8' {...ICON_LINE} />
    <circle cx={2.8} cy={12.4} r={1.8} />
    <circle cx={13.2} cy={3.6} r={1.8} />
  </Icon>
);

export const FEATURE_ICONS: Record<PresetFeature, React.ComponentType> = {
  clip: PlayIcon,
  ai: AiIcon,
  'tempo-sync': TempoSyncIcon,
  mono: MonoIcon,
  glide: GlideIcon,
};

// what a preset does: an icon each, its name and what it means in its tooltip
const Mark = styled.span`
  flex: none;
  display: flex;
  align-items: center;
  font-size: 13px;
  color: ${colors.primaryDarkHighContrast};

  svg {
    width: 1em;
    height: 1em;
  }
`;

export const FeatureMark = ({ feature }: { feature: PresetFeature }) => {
  const { label, hint } = FEATURE_LOOKS[feature];
  const FeatureIcon = FEATURE_ICONS[feature];
  return (
    <Tooltip title={`${label}: ${hint}`}>
      <Mark role='img' aria-label={label}>
        <FeatureIcon />
      </Mark>
    </Tooltip>
  );
};
