import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { keepFocus, panelKeyStyle, panelKeySunken, theme } from '@chisper/ui-kit';

const { colors } = theme;

export interface Choice<T> {
  value: T;
  label: React.ReactNode;
  // its accessible name where the label says less (1: Channel 1)
  name?: string;
}

// the keys on a plate as the strip of keys of the header: the line of its strips between them and around them (the
// gap of 1px)
const Plate = styled.div`
  display: flex;
  gap: 1px;
  padding: 1px;
  overflow: hidden;
  border-radius: 3px;
  background: ${colors.primaryLowContrast};
`;

// a key of the header strip (PanelButton) on a plate, smaller: the one chosen pressed in with its label blue;
// `signal` lights a dot in its corner (a note of its channel held)
const Key = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${panelKeyStyle};
  height: 26px;
  flex-direction: column;
  gap: 0;
  padding: 0 4px;
  border-radius: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;

  &[aria-checked='true'] {
    background: ${colors.primary};
    box-shadow: ${panelKeySunken};
    color: ${colors.secondAccent};
  }

  // lit at once, fading out
  &::after {
    content: '';
    position: absolute;
    top: 3px;
    right: 3px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: ${colors.accent};
    box-shadow: 0 0 4px 1px ${hexToRgba(colors.accent, 0.7)};
    opacity: 0;
    transition: opacity 200ms;
  }

  &.signal::after {
    opacity: 1;
    transition: none;
  }

  &:focus-visible {
    outline: 1px solid ${colors.secondAccent};
    outline-offset: -2px;
  }
`;

interface Props<T> {
  // the name of the group (Latency)
  'aria-label': string;
  options: Choice<T>[];
  value: T;
  // only for another choice than the one made (a choice may cost: a reload)
  onChange: (value: T) => void;
}

// a choice of one of a few on keys of a plate (the latency, the channel of the MIDI): radios, each key its value in
// data-value
export const ChoiceKeys = <T extends string | number>({
  options,
  value,
  onChange,
  'aria-label': label,
}: Props<T>) => (
  <Plate role='radiogroup' aria-label={label}>
    {options.map((option) => (
      <Key
        key={option.value}
        role='radio'
        aria-checked={option.value === value}
        aria-label={option.name}
        data-value={option.value}
        onClick={() => option.value !== value && onChange(option.value)}
      >
        {option.label}
      </Key>
    ))}
  </Plate>
);
