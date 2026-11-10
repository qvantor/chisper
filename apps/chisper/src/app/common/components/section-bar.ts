import { css, styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { keepFocus, textBold12, theme } from '@chisper/ui-kit';

const WHITE = theme.colors.white;

// a section of the synth over the page (its header, the dark screen under it): the roll, the dialogs, the popovers

// the shadow it casts on the page
export const SECTION_SHADOW = '0 4px 12px rgb(0 0 0 / 25%)';

// its plate: the light around its header and its content
export const sectionStyle = css`
  padding: 6px;
  border-radius: 3px;
  background: ${theme.colors.primary};
  box-shadow: ${SECTION_SHADOW};
`;

// the header of a section of the synth: its grey, its white bold label
export const barStyle = css`
  ${textBold12};
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding: 0 3px 0 8px;
  border-radius: 3px;
  background: ${theme.colors.primaryLowContrast};
  color: ${WHITE};
`;

export const Bar = styled.div`
  ${barStyle}
`;

export const BarTitle = styled.span`
  flex: none;
  margin-right: 6px;
  letter-spacing: 1.5px;
`;

// a key of the header: uppercase as the keys of the header of the synth, white on its grey
export const keyStyle = css`
  ${textBold12};
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: ${WHITE};
  letter-spacing: 1px;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 120ms;

  svg {
    flex: none;
    font-size: 14px;
  }

  &:hover {
    background: ${hexToRgba(WHITE, 0.22)};
  }

  &:active,
  &.open {
    background: ${hexToRgba(theme.colors.primaryDark, 0.2)};
  }

  &:disabled {
    cursor: default;
    opacity: 0.6;
  }

  &.square {
    width: 24px;
    padding: 0;
    justify-content: center;
  }

  &:focus-visible {
    outline: 1px solid ${WHITE};
  }
`;

export const Key = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${keyStyle}
`;

// the screen of the roll: the dark of the charts, sunk into the section
export const screenStyle = css`
  border-radius: 3px;
  background: ${theme.colors.primaryDark};
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 50%);
`;

// the room between the keys of a bar on the left and those on the right
export const Spacer = styled.div`
  flex: 1 1 0;
`;

// a dot of the blue of the synth after a name: what it names is not saved (a clip, the preset playing)
export const DirtyDot = styled.span`
  flex: none;
  width: 7px;
  height: 7px;
  margin: 0 4px;
  border-radius: 50%;
  background: ${theme.colors.secondAccent};
`;
