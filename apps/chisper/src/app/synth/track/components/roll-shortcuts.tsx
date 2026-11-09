import React from 'react';
import { styled } from 'styled-components';
import { Popover } from 'antd';
import { text10, text12, textBold12, theme } from '@chisper/ui-kit';

// Cmd on a Mac, Ctrl elsewhere
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl+';

// the keys of the edits, in the tooltips of their keys and in the list
export const KEYS = {
  draw: `${modKey}B`,
  undo: `${modKey}Z`,
  redo: `${isMac ? '⇧⌘' : 'Ctrl+Shift+'}Z`,
  quantize: 'Shift+Q',
  legato: `${modKey}L`,
  play: 'Space',
  record: 'Shift+R',
  follow: 'F',
  zoomIn: '+',
  zoomOut: '−',
  fit: 'Shift+F',
  shortcuts: '?',
};

// what the roll does by the keys and the pointer, by group
export const ROLL_SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Notes',
    items: [
      ['Double-click', 'Select mode: add a note, or take one away'],
      [KEYS.draw, 'Draw or select (draw: click and drag)'],
      ['Right click', 'Draw mode: take a note away (dragged: those it passes)'],
      ['Drag the right edge', 'Longer or shorter'],
      ['Alt + drag', 'Off the grid'],
      ['Shift + click', 'Add to the selection'],
      ['Delete', 'Take the selected notes away'],
      ['Esc', 'Give a drag up, clear the selection'],
    ],
  },
  {
    group: 'Edit',
    items: [
      ['↑ ↓', 'A semitone (Shift: an octave)'],
      ['← →', 'A step of the grid (Shift: longer, shorter)'],
      [`${modKey}A`, 'Select all'],
      [`${modKey}C  ${modKey}X  ${modKey}V`, 'Copy, cut, paste at the pointer'],
      [`${modKey}D`, 'Duplicate after them'],
      [KEYS.quantize, 'Quantize to the grid'],
      [KEYS.legato, 'Legato'],
      [`${KEYS.undo}  ${KEYS.redo}`, 'Undo, redo'],
    ],
  },
  {
    group: 'Play and view',
    items: [
      [KEYS.play, 'Play, stop'],
      [KEYS.record, 'Record the keys and MIDI into the loop'],
      ['Click the ruler', 'Play from that bar'],
      [KEYS.follow, 'Follow the playhead'],
      [`${KEYS.zoomIn}  ${KEYS.zoomOut}`, 'Zoom in, out'],
      [KEYS.fit, 'Fit the loop and a bar after it'],
      ['Wheel', 'Scroll (Shift: across)'],
      [`${modKey}wheel  Alt+wheel`, 'Zoom across, the rows'],
      [KEYS.shortcuts, 'This list'],
    ],
  },
];

const List = styled.div`
  display: grid;
  grid-template-columns: repeat(3, auto);
  gap: 14px 20px;
  max-width: 760px;
  color: ${theme.colors.primaryDark};
`;

const Group = styled.div`
  display: grid;
  grid-template-columns: auto 1fr;
  align-content: start;
  gap: 5px 10px;
`;

const Title = styled.div`
  ${textBold12};
  grid-column: 1 / -1;
  color: ${theme.colors.primaryHighContrast};
  letter-spacing: 1px;
  text-transform: uppercase;
`;

const Keys = styled.kbd`
  ${text10};
  justify-self: start;
  align-self: start;
  padding: 3px 5px;
  border-radius: 3px;
  background: ${theme.colors.primaryDark};
  color: ${theme.colors.white};
  font-family: inherit;
  font-weight: 600;
  white-space: pre;
`;

const Action = styled.span`
  ${text12};
  align-self: center;
`;

// the list of the keys of the roll in a popover under `children` (the ? key of its header); also opened by ?
export const ShortcutsPopover = ({
  open,
  onOpenChange,
  children,
}: React.PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) => (
  <Popover
    open={open}
    onOpenChange={onOpenChange}
    trigger='click'
    placement='bottomRight'
    content={
      <List data-testid='roll-shortcuts'>
        {ROLL_SHORTCUTS.map(({ group, items }) => (
          <Group key={group}>
            <Title>{group}</Title>
            {items.map(([keys, action]) => (
              <React.Fragment key={action}>
                <Keys>{keys}</Keys>
                <Action>{action}</Action>
              </React.Fragment>
            ))}
          </Group>
        ))}
      </List>
    }
  >
    {children}
  </Popover>
);
