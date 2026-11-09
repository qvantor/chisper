import React from 'react';
import { css, styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { ConfigProvider, Modal, ModalProps } from 'antd';
import { AiOutlineClose } from 'react-icons/ai';
import { checkboxLit, checkboxOff, text12, textBold12, theme } from '@chisper/ui-kit';
import { barStyle, keyStyle, screenStyle, sectionStyle } from './section-bar';

const { colors } = theme;

// the boxes of antd in the colors of the checkboxes of the synth, its states the rules below don't reach (a hover);
// the fields white on the dark of the screen they sit on
const DIALOG_THEME = {
  components: {
    Checkbox: {
      colorPrimary: colors.secondAccent,
      colorPrimaryHover: colors.secondAccent,
      colorBgContainer: colors.primaryHighContrast,
      colorBorder: colors.primaryDarkMediumContrast,
      controlInteractiveSize: 12,
      borderRadiusSM: 3,
    },
    Input: {
      colorBgContainer: colors.primaryDark,
      colorText: colors.white,
      colorTextPlaceholder: colors.primaryDarkHighContrast,
      // the count, the clear key and its hover
      colorTextDescription: colors.primaryDarkHighContrast,
      colorTextQuaternary: colors.primaryDarkHighContrast,
      colorIcon: colors.white,
      colorError: colors.red,
      colorErrorAffix: colors.red,
      inputFontSize: 13,
    },
  },
};

// a section of the synth over the page, as the roll is: its header (the title, the close key), its content under it
// (the dark screen, a bar of keys); doubled (&&) over the rules of antd
const Root = styled(Modal)`
  // a click on the dialog (off its keys) focuses its panel: no outline of antd around the whole dialog after a key
  // then (a note of the keyboard), its keys and fields show their own
  &&:focus-visible {
    outline: none;
  }

  && .ant-modal-container {
    ${sectionStyle};
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  && .ant-modal-header {
    ${barStyle};
    margin: 0;
    padding-right: 30px;
    border-bottom: none;
  }

  && .ant-modal-title {
    ${textBold12};
    color: ${colors.white};
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }

  && .ant-modal-close {
    ${keyStyle};
    top: 9px;
    inset-inline-end: 9px;
    width: 24px;
    padding: 0;
    justify-content: center;
  }

  && .ant-modal-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0;
  }

  // a field of a screen: no outline, focused or not (tripled: over its error state)
  &&& .ant-input-borderless {
    outline: none;
  }

  && .ant-checkbox {
    ${checkboxOff};
  }

  && .ant-checkbox-checked {
    ${checkboxLit};
  }

  // lit, as the checkboxes of the synth: no tick
  && .ant-checkbox-checked::after {
    display: none;
  }

  && .ant-checkbox-indeterminate::after {
    width: 6px;
    height: 6px;
    border-radius: 1px;
    background: ${colors.secondAccent};
  }
`;

const MASK = { background: hexToRgba(colors.primaryDark, 0.55) };

// a dialog of the synth: its title in its header, a close key, no footer of antd (a Bar of keys in its content)
export const Dialog = (props: Omit<ModalProps, 'footer' | 'closeIcon' | 'centered' | 'styles'>) => (
  <ConfigProvider theme={DIALOG_THEME}>
    <Root closeIcon={<AiOutlineClose />} footer={null} centered styles={{ mask: MASK }} {...props} />
  </ConfigProvider>
);

// a line of text over the screen
export const DialogIntro = styled.div`
  ${text12};
  padding: 2px 2px 0;
  color: ${colors.primaryDarkMediumContrast};
`;

// the dark screen of a dialog, its rows in a column
export const DialogScreen = styled.div`
  ${screenStyle};
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

// the first row of a screen (a field, All), a hairline under it
export const ScreenHead = styled.div`
  flex: none;
  display: flex;
  align-items: center;
  border-bottom: 1px solid ${hexToRgba(colors.white, 0.08)};
`;

// the rows of a screen scrolled where there are many
export const screenScrollStyle = css`
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: ${colors.primaryDarkMediumContrast} transparent;
`;

// a row of a screen (a part of a .mid, a preset), hovered as a value of the screens of the synth
export const screenItemStyle = css`
  padding: 5px 8px;
  border-radius: 2px;
  transition: background 120ms;

  &:hover {
    background: ${hexToRgba(colors.primaryDarkMediumContrast, 0.6)};
  }
`;

// a lit row of a screen (the preset playing, the file chosen): in blue, as a lit key of the synth, a line of it on its
// left
export const screenLitStyle = css`
  background: ${hexToRgba(colors.secondAccent, 0.14)};
  box-shadow: inset 2px 0 0 ${colors.secondAccent};
`;

// a row of a screen with a box (a part of a .mid, the clip of a preset): the box on the line of its name (not the line
// of antd), its texts beside it
export const screenCheckStyle = css`
  ${screenItemStyle};

  .ant-checkbox-wrapper {
    align-items: flex-start;
  }

  .ant-checkbox {
    align-self: flex-start;
    margin-top: 2px;
  }

  .ant-checkbox-label {
    display: flex;
    min-width: 0;
  }
`;
