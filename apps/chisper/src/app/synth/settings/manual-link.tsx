import React from 'react';
import { MdOpenInNew } from 'react-icons/md';
import { styled } from 'styled-components';
import { textBold12, theme } from '@chisper/ui-kit';
import { MANUAL_PATH } from '../../common/components';

const { colors } = theme;

// a line of the Settings popover: the book, the name, on the right the mark of a new tab
const Root = styled.a`
  ${textBold12};
  display: flex;
  align-items: center;
  gap: 8px;
  color: ${colors.primaryDarkMediumContrast};
  letter-spacing: 1.2px;
  text-transform: uppercase;
  text-decoration: none;
  cursor: pointer;
  transition: color 120ms;

  svg {
    flex: 0 0 auto;
    font-size: 17px;
  }

  &:hover {
    color: ${colors.secondAccent};
  }
`;

const NewTab = styled(MdOpenInNew)`
  margin-left: auto;
  opacity: 0.6;

  && {
    font-size: 13px;
  }
`;

// an open book with a wave on its right page (the icon of the manual on the site, BookIcon.astro), flat: the
// color of the line, no glow
const BookIcon = () => (
  <svg
    width='1em'
    height='1em'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='1.9'
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
  >
    <path d='M12 6.6C10.4 5.3 8 4.6 5.2 4.6c-.9 0-1.8.1-2.6.3v13c.8-.2 1.7-.3 2.6-.3 2.8 0 5.2.7 6.8 2 1.6-1.3 4-2 6.8-2 .9 0 1.8.1 2.6.3v-13c-.8-.2-1.7-.3-2.6-.3-2.8 0-5.2.7-6.8 2z' />
    <path d='M12 6.6v13' />
    <path d='M14.7 12.1c.8-1.9 1.6-1.9 2.4 0s1.6 1.9 2.4 0' strokeWidth='1.5' />
  </svg>
);

// the manual of the synth (the site), in a new tab: the synth plays on in its own with what no preset keeps
export const ManualLink = () => (
  <Root href={MANUAL_PATH} target='_blank' rel='noopener'>
    <BookIcon />
    Manual
    <NewTab aria-hidden />
  </Root>
);
