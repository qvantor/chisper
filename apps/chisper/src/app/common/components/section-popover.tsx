import React from 'react';
import { styled } from 'styled-components';
import { Popover } from 'antd';
import { text10, text12, theme } from '@chisper/ui-kit';
import { Bar, BarTitle, SECTION_SHADOW, Spacer } from './section-bar';

const { colors } = theme;

// the panel of antd as a section of the synth: its light around the header and the groups under it
const PANEL: React.CSSProperties = {
  padding: 6,
  borderRadius: 3,
  background: colors.primary,
  boxShadow: SECTION_SHADOW,
};

// moved along its key into the screen where it would stick out of it (a browser of files from the left of its name
// on a phone), turned up where there is no room under it
const ALIGN = { overflow: { shiftX: true, adjustY: true } };

// within a phone's width (16px on each side, the padding of the panel)
const Content = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: calc(100vw - 44px);
`;

// uppercase, as the titles of the dialogs
const Title = styled(BarTitle)`
  text-transform: uppercase;
`;

const Body = styled.div`
  display: flex;
  flex-direction: column;
`;

// a group of the section (its label, its keys), the line of the strips of the header between two
export const PopoverGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px 3px 9px;

  & + & {
    border-top: 1px solid ${colors.primaryLowContrast};
  }
`;

// the label of a group, in the grey of the labels of the synth
export const GroupLabel = styled.div`
  ${text10};
  color: ${colors.primaryHighContrast};
  font-weight: 600;
  letter-spacing: 1.2px;
  text-transform: uppercase;
`;

// a line of text of a group
export const PopoverNote = styled.div`
  ${text12};
  line-height: 16px;
  color: ${colors.primaryHighContrast};
`;

interface Props {
  title: string;
  // on the right of the header (a lamp)
  extra?: React.ReactNode;
  // the groups under the header
  content: React.ReactNode;
  width: number;
  // under its key, from its right edge (the keys on the right of the header) or its left one
  placement?: 'bottomRight' | 'bottomLeft';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // the key it opens under
  children: React.ReactElement;
}

// rendered straight into the page: its content is in it from its first layout (a browser of files measures and
// focuses its rows then), not a moment later in a container of its own
const inPage = () => document.body;

// a section of the synth under its key (the MIDI, the settings), as Noise or Voicing are: its grey header, its groups
// on its light under it; a click elsewhere closes it, its content is gone while it is closed (nothing of it listens
// meanwhile)
export const SectionPopover = ({
  title,
  extra,
  content,
  width,
  placement = 'bottomRight',
  open,
  onOpenChange,
  children,
}: Props) => (
  <Popover
    trigger='click'
    placement={placement}
    align={ALIGN}
    open={open}
    onOpenChange={onOpenChange}
    destroyOnHidden
    getPopupContainer={inPage}
    styles={{ container: PANEL }}
    content={
      <Content style={{ width }}>
        <Bar>
          <Title>{title}</Title>
          <Spacer />
          {extra}
        </Bar>
        <Body>{content}</Body>
      </Content>
    }
  >
    {children}
  </Popover>
);
