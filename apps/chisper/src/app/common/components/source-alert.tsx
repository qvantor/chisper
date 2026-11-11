import React from 'react';
import { styled } from 'styled-components';
import { MdWarningAmber } from 'react-icons/md';
import { text12, theme } from '@chisper/ui-kit';

const Root = styled.div`
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 6px;
  ${text12};
  line-height: 16px;
  text-align: center;
  color: ${theme.colors.primaryDarkHighContrast};
  background: ${theme.colors.primaryDark}cc;

  svg {
    flex: 0 0 auto;
    font-size: 12px;
    color: ${theme.colors.red};
  }
`;

// a text button, as in the warning of a failed effect
const Retry = styled.button`
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-weight: bold;
  color: ${theme.colors.secondAccent};
  text-decoration: underline;
  cursor: pointer;

  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: 1px solid ${theme.colors.secondAccent};
    outline-offset: 2px;
  }
`;

interface Props {
  // Retry, when there is one
  onRetry?: (() => void) | false;
  className?: string;
}

// over a window of a source (the noise, the sub): a warning, why it doesn't play, and Retry; it covers its parent
// (positioned)
export const SourceAlert = ({ onRetry, className, children }: React.PropsWithChildren<Props>) => (
  <Root role='alert' className={className}>
    <MdWarningAmber aria-hidden />
    <span>{children}</span>
    {onRetry && (
      <Retry type='button' onClick={onRetry}>
        Retry
      </Retry>
    )}
  </Root>
);
