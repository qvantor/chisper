import React from 'react';
import { styled } from 'styled-components';
import { FxScreen } from '../fx';
import { SynthScreen } from '../screens';
import { MobileRoll, useLinkPreset } from '../track';
import { SynthSections } from './synth-sections';

const Root = styled.div`
  height: 100%;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
`;

// narrower charts: on a phone (360px and up) the filter or the decay group shares its line with the next one
const Fx = styled(FxScreen)`
  height: 100%;
  --fx-chart-width: 128px;
`;

// the piano roll of the clip of the track, as high as the view
const ClipRoll = () => <MobileRoll presetId={useLinkPreset()} />;

export const SynthView = ({ portrait, screen }: { portrait: boolean; screen: SynthScreen }) => (
  <Root>
    {screen === 'fx' ? (
      <Fx layout={portrait ? 'column' : 'row'} />
    ) : screen === 'clip' ? (
      <ClipRoll />
    ) : (
      <SynthSections layout={portrait ? 'column' : 'grid'} />
    )}
  </Root>
);
