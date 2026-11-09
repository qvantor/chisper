import React from 'react';
import cls from 'classnames';
import { css, keyframes, styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { Toast, Toaster } from 'react-hot-toast';
import { theme } from '@chisper/ui-kit';
import { Bar, sectionStyle, Spacer } from './section-bar';

const { colors } = theme;

// the light of the LED of a toast: its type
const led = (color: string) => css`
  background: ${color};
  box-shadow: 0 0 4px 1px ${hexToRgba(color, 0.7)};
`;

const enter = keyframes`
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.96);
  }
`;

const leave = keyframes`
  to {
    opacity: 0;
    transform: translateY(-6px) scale(0.96);
  }
`;

const fadeIn = keyframes`
  from {
    opacity: 0;
  }
`;

const fadeOut = keyframes`
  to {
    opacity: 0;
  }
`;

const Led = styled.span`
  flex: none;
  width: 6px;
  height: 6px;
  // in the middle of the first line
  margin-top: 6px;
  border-radius: 50%;
  ${led(colors.secondAccent)}
`;

// a section of the synth over the page, as the dialogs are: its text on its light (and the bar of keys of an ask);
// its type lights the LED before the text. Only its transform and opacity move (no relayout)
const Plate = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  ${sectionStyle};
  max-width: min(360px, 100%);
  box-sizing: border-box;
  pointer-events: auto;
  animation: ${enter} 220ms ease-out;

  // its height not known yet: the toaster hasn't moved the others for it
  &.measuring {
    opacity: 0;
  }

  &.leaving {
    animation: ${leave} 180ms ease-in forwards;
  }

  @media (prefers-reduced-motion: reduce) {
    animation-name: ${fadeIn};

    &.leaving {
      animation-name: ${fadeOut};
    }
  }

  &[data-type='success'] ${Led} {
    ${led(colors.accent)}
  }

  &[data-type='error'] ${Led} {
    ${led(colors.red)}
  }
`;

const Text = styled.div`
  display: flex;
  gap: 8px;
  padding: 4px 6px;
  font-size: 13px;
  line-height: 18px;
  color: ${colors.primaryDarkMediumContrast};
  white-space: pre-line;
  overflow-wrap: anywhere;
`;

// the text of a toast, after the LED of its type
const ToastText = ({ children }: React.PropsWithChildren) => (
  <Text>
    <Led />
    <span>{children}</span>
  </Text>
);

// a toast that asks for an answer: its text, its keys (Key) in the bar under it, as a dialog has
export const ToastAsk = ({ text, children }: React.PropsWithChildren<{ text: React.ReactNode }>) => (
  <>
    <ToastText>{text}</ToastText>
    <Bar>
      <Spacer />
      {children}
    </Bar>
  </>
);

// a toast of any type: a string as its text, an element (ToastAsk) all of its content
const ToastCard = ({ toast }: { toast: Toast }) => {
  const message = typeof toast.message === 'function' ? toast.message(toast) : toast.message;
  return (
    <Plate
      className={cls({ measuring: !toast.height, leaving: !toast.visible })}
      data-type={toast.type}
      {...toast.ariaProps}
    >
      {typeof message === 'string' ? <ToastText>{message}</ToastText> : message}
    </Plate>
  );
};

// the toasts of react-hot-toast drawn as sections of the synth (its queue, timers, places and pause on hover kept)
export const Toasts = () => <Toaster position='top-center'>{(toast) => <ToastCard toast={toast} />}</Toaster>;
