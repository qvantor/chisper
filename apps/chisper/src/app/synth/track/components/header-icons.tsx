import React from 'react';
import { styled } from 'styled-components';

// icons of the keys of the header of the roll, 16 × 16 in currentColor as those of the strip, at the size of the
// key's icons (1em)

// an icon of lines in currentColor: 16 × 16 at the size of the key's icons, or `width` × `height` pixels (the icons of
// Export WAV)
export const Icon = ({
  width,
  height,
  children,
}: React.PropsWithChildren<{ width?: number; height?: number }>) => (
  <svg
    viewBox={`0 0 ${width ?? 16} ${height ?? 16}`}
    width={width ?? '1em'}
    height={height ?? '1em'}
    fill='none'
    stroke='currentColor'
    strokeWidth={1.4}
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden
    focusable='false'
  >
    {children}
  </svg>
);

// a file saved: an arrow down into a tray (.mid, .wav)
export const DownloadIcon = () => (
  <Icon>
    <path d='M8 2v8.2' />
    <path d='M4.8 7.1L8 10.3l3.2-3.2' />
    <path d='M2.5 10.6v1.7c0 .9.8 1.7 1.7 1.7h7.6c.9 0 1.7-.8 1.7-1.7v-1.7' />
  </Icon>
);

// a file opened into the clip: an arrow going into a page from its left
export const ImportIcon = () => (
  <Icon>
    <path d='M5.4 5.4V3.5c0-.9.8-1.7 1.7-1.7h3.4l3.2 3.2v7.5c0 .9-.8 1.7-1.7 1.7H7.1c-.9 0-1.7-.8-1.7-1.7v-1.9' />
    <path d='M10.4 1.9v2.5c0 .5.4.8.8.8h2.5' />
    <path d='M1.6 8h6.6' />
    <path d='M5.9 5.7L8.2 8l-2.3 2.3' />
  </Icon>
);

// a new clip: a page with a plus on it
export const NewClipIcon = () => (
  <Icon>
    <path d='M4.9 1.8h4.3l3.6 3.6v6.9c0 .9-.8 1.7-1.7 1.7H4.9c-.9 0-1.7-.8-1.7-1.7V3.5c0-.9.8-1.7 1.7-1.7z' />
    <path d='M9.1 1.9v2.7c0 .5.4.8.8.8h2.8' />
    <path d='M8 7.6v4.2M5.9 9.7h4.2' />
  </Icon>
);

// the keys of the roll: a keyboard, its keys and its space bar
export const ShortcutsIcon = () => (
  <Icon>
    <rect x={1.5} y={3.5} width={13} height={9} rx={1.8} />
    <path d='M4.3 6.4h.01M6.8 6.4h.01M9.2 6.4h.01M11.7 6.4h.01' strokeWidth={1.6} />
    <path d='M5.3 9.6h5.4' />
  </Icon>
);

// the extension of the file a key saves, beside its icon: as a file names it (lowercase)
export const Ext = styled.span`
  text-transform: none;
  letter-spacing: 0.6px;
`;
