import type React from 'react';
import { styled } from 'styled-components';
import { text10, theme } from '@chisper/ui-kit';

// a cell of the grid of a roll: its canvases over all of it, the pointer its own (no scroll of the page)
export const RollCell = styled.div`
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  touch-action: none;

  & > canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
`;

// the grid of the notes of a roll: a line between it and the ruler over it
export const RollGrid = styled(RollCell)`
  border-top: 1px solid ${theme.colors.primaryDarkMediumContrast};
`;

// a corner of the roll beside its lanes: a label or a value of the color of the labels of the synth
export const RollCorner = styled.div`
  ${text10};
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  overflow: hidden;
  color: ${theme.colors.primaryDarkHighContrast};
  font-weight: 600;
  letter-spacing: 0.5px;
  font-variant-numeric: tabular-nums;
  background: ${theme.colors.primaryDark};
  border-right: 1px solid ${theme.colors.primaryDarkMediumContrast};
  white-space: nowrap;
`;

// a drag held on a cell of the roll ends when its release is lost (the button let go outside the window, or while
// another app had the focus): at a move without a button, or as the capture of the pointer is lost (Chrome drops it
// at that move). Else it would follow the mouse with no button held (`singlePointerTracker` of the ui-kit does the
// same for its controls)
export const releaseLost = (e: React.PointerEvent) => e.buttons === 0;
