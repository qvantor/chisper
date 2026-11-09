import React from 'react';
import { styled } from 'styled-components';
import { Tooltip } from 'antd';
import { AiOutlineLeft, AiOutlineLink, AiOutlineReload, AiOutlineRight, AiOutlineSave } from 'react-icons/ai';
import toast from 'react-hot-toast';
import { LoadProgress, PanelButton, theme } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { useApp } from '../../app';
import { INIT_NAME, usePresets } from '../modules/presets';
import { sharePreset } from '../services';
import { PresetBrowser } from './preset-browser';
import { SaveDialog } from './save-dialog';
import { UsageReporter } from './usage-reporter';

const Dirty = styled.span`
  color: ${theme.colors.secondAccent};
`;

// two rows of equal height: ◀ name Init ▶ on top, a strip of action keys below
const Section = styled.div`
  min-width: 0;
  display: grid;
  grid-template-rows: 1fr 1fr;
  gap: 1px;
  background: ${theme.colors.primaryLowContrast};
`;

const Row = styled.div`
  min-width: 0;
  display: flex;
  gap: 1px;
`;

const RowButton = styled.button`
  border: none;
  background: ${theme.colors.primary};
  font-size: 15px;
  cursor: pointer;
  transition: color 120ms;

  &:hover {
    color: ${theme.colors.secondAccent};
  }
`;

// a square key: ◀, ▶ and Init
const IconButton = styled(RowButton)`
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: ${theme.colors.primaryHighContrast};
`;

// the name over the progress of a preset opening
const SectionName = styled(RowButton)`
  position: relative;
  flex: 1 1;
  min-width: 0;
  padding: 0 12px;
  color: ${theme.colors.primaryDark};
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const NameText = styled.span`
  position: relative;
`;

// (its own component: the progress of a download changes with every chunk, the section renders not)
const OpeningProgress = () => {
  const [{ $loadProgress }] = usePresets();
  const progress = useBehaviorSubject($loadProgress);
  return <LoadProgress progress={progress} look='fill' color={theme.colors.secondAccent} />;
};

interface SectionProps {
  // more keys after Save and Share
  actions?: React.ReactNode;
  className?: string;
}

export const PresetSection = ({ actions, className }: SectionProps) => {
  const [{ $saveRequest }] = useApp();
  const [{ $current, $dirty, $opening }, { next, prev, reset }] = usePresets();
  const current = useBehaviorSubject($current);
  const dirty = useBehaviorSubject($dirty);
  // a preset opening shows its name at once ('Loading…' until it is known: a link)
  const opening = useBehaviorSubject($opening);
  const name = opening ? (opening.name ?? 'Loading…') : (current?.name ?? INIT_NAME);
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);

  // Cmd/Ctrl+S
  React.useEffect(() => {
    const subscription = $saveRequest.subscribe(() => setSaveOpen(true));
    return () => subscription.unsubscribe();
  }, [$saveRequest]);

  const share = () => {
    if (!current) {
      toast.error('Save the preset first to share it');
      return;
    }
    sharePreset(current.id);
  };

  return (
    <Section className={className}>
      <Row>
        <IconButton aria-label='Previous preset' onClick={prev}>
          <AiOutlineLeft />
        </IconButton>
        <Tooltip title='Browse presets'>
          <SectionName onClick={() => setBrowserOpen(true)}>
            <OpeningProgress />
            <NameText>
              {name}
              {!opening && dirty && <Dirty> *</Dirty>}
            </NameText>
          </SectionName>
        </Tooltip>
        <Tooltip title='Init preset'>
          <IconButton aria-label='Init preset' onClick={reset}>
            <AiOutlineReload />
          </IconButton>
        </Tooltip>
        <IconButton aria-label='Next preset' onClick={next}>
          <AiOutlineRight />
        </IconButton>
      </Row>
      <Row>
        <Tooltip title='Save as a new preset (⌘S)'>
          <PanelButton icon={<AiOutlineSave />} onClick={() => setSaveOpen(true)}>
            Save
          </PanelButton>
        </Tooltip>
        <Tooltip title='Copy link'>
          <PanelButton icon={<AiOutlineLink />} onClick={share}>
            Share
          </PanelButton>
        </Tooltip>
        {actions}
      </Row>
      <PresetBrowser open={browserOpen} onClose={() => setBrowserOpen(false)} />
      <SaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
      <UsageReporter />
    </Section>
  );
};
