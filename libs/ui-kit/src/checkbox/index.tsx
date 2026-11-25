import React from 'react';
import cls from 'classnames';
import { css, styled } from 'styled-components';
import { theme } from '../common/constants';
import { Label } from '../label';
import { useMidiAttrs } from '../midi-learn';

// the box of a checkbox of the synth: grey while off, lit in blue while on (for other checkboxes to look the same)
export const checkboxOff = css`
  background: ${theme.colors.primaryHighContrast};
  border: 1px solid ${theme.colors.primaryDarkMediumContrast};
  border-radius: 3px;
  box-shadow: none;
`;

export const checkboxLit = css`
  background: ${theme.colors.secondAccent};
  box-shadow:
    inset 0 0 0 1px #99cbec,
    0 0 3px 2px rgba(153, 203, 236, 0.5);
`;

const Root = styled.div`
  display: flex;
  gap: 5px;
  align-items: center;
`;

const Indicator = styled.div`
  ${checkboxOff};
  width: 12px;
  height: 12px;
  transition: all 150ms;

  &.checked {
    ${checkboxLit};
  }
`;

interface Props {
  checked: boolean;
  label: React.ReactNode;
  onChange: (value: boolean) => void;
  // its id of MIDI Learn (a CC switches it)
  midiTarget?: string;
}

type OnChangeInternal = { onChangeInternal: () => void };

type CheckboxProps = Partial<Pick<Props, 'label' | 'onChange'>> & Omit<Props, 'label' | 'onChange'>;
type SimpleCheckboxProps = Pick<Props, 'checked' | 'midiTarget'> & OnChangeInternal;
type LabeledCheckboxProps = Omit<Props, 'onChange'> & OnChangeInternal;

const SimpleCheckbox = ({ onChangeInternal, checked, midiTarget }: SimpleCheckboxProps) => (
  <Indicator onClick={onChangeInternal} className={cls({ checked: checked })} {...useMidiAttrs(midiTarget)} />
);

const LabeledCheckbox = ({ onChangeInternal, checked, label, midiTarget }: LabeledCheckboxProps) => {
  return (
    <Root onClick={onChangeInternal} {...useMidiAttrs(midiTarget)}>
      <Indicator className={cls({ checked: checked })} />
      <Label>{label}</Label>
    </Root>
  );
};

export const Checkbox = ({ checked, label, onChange, midiTarget }: CheckboxProps) => {
  const onChangeInternal = () => onChange?.(!checked);
  return label ? (
    <LabeledCheckbox
      label={label}
      onChangeInternal={onChangeInternal}
      checked={checked}
      midiTarget={midiTarget}
    />
  ) : (
    <SimpleCheckbox checked={checked} onChangeInternal={onChangeInternal} midiTarget={midiTarget} />
  );
};
