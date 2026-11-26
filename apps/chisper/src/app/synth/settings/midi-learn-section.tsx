import React from 'react';
import { BehaviorSubject } from 'rxjs';
import { styled } from 'styled-components';
import cls from 'classnames';
import { CloseOutlined } from '@ant-design/icons';
import { keepFocus, Lamp, text10, text12, textBold12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject, useObservable } from '@chisper/rxjs-react';
import {
  ChoiceKeys,
  GroupLabel,
  PopoverGroup,
  PopoverNote,
  screenScrollStyle,
} from '../../common/components';
import { MidiLearnModelContext, MidiLearnModule, Takeover } from '../common/midi-learn/midi-learn';

const { colors } = theme;

// the lamp and its name: a press anywhere on it switches it (as the switch of the clock); what it does on the right
const Switch = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 1px;
  user-select: none;
  cursor: pointer;

  &.disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

const SwitchName = styled.span`
  ${textBold12};
  color: ${colors.primaryDarkMediumContrast};
`;

const SwitchState = styled.span`
  ${text12};
  margin-left: auto;
  color: ${colors.primaryHighContrast};
  white-space: nowrap;

  &.on {
    ${textBold12};
    color: ${colors.secondAccent};
  }
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

// the bindings by CC, a few rows, then a scroll
const Bindings = styled.ul`
  ${screenScrollStyle};
  max-height: 140px;
  margin: 0 -3px;
  list-style: none;
`;

const Binding = styled.li`
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  padding: 0 3px;
  border-radius: 3px;

  &:hover {
    background: ${colors.white};
  }
`;

const Cc = styled.span`
  ${text10};
  flex: none;
  width: 42px;
  font-weight: 700;
  color: ${colors.secondAccent};
  font-variant-numeric: tabular-nums;
`;

const Name = styled.span`
  ${text12};
  flex: 1 1 auto;
  min-width: 0;
  color: ${colors.primaryDarkMediumContrast};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Remove = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: none;
  color: ${colors.primaryHighContrast};
  font-size: 11px;
  cursor: pointer;

  &:hover {
    color: ${colors.red};
  }
`;

const ClearAll = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${text10};
  margin-left: auto;
  padding: 2px 6px;
  border: none;
  border-radius: 3px;
  background: none;
  color: ${colors.primaryHighContrast};
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: ${colors.red};
  }

  &:disabled {
    cursor: default;
    opacity: 0.4;
  }
`;

const TAKEOVER_OPTIONS: { value: Takeover; label: string; name: string }[] = [
  { value: 'jump', label: 'Jump', name: 'Jump: a control goes where the CC is at once' },
  { value: 'pickup', label: 'Pickup', name: 'Pickup: a control waits until the CC passes its value' },
];

const LEARN = 'MIDI Learn';

// the Learn mode: a press on a control chooses it, the next CC is bound to it (without MIDI it can't be switched on)
const LearnSwitch = ({ module: [{ $learnMode, $learning }, { setLearnMode }], access }: Props) => {
  const on = useBehaviorSubject($learnMode);
  const learning = useBehaviorSubject($learning);
  const state = () => {
    if (!access) return 'No MIDI input';
    if (!on) return 'Off';
    return learning?.via === 'mode' ? 'Move a control' : 'Press a control';
  };
  return (
    <Switch className={cls({ disabled: !access })} onClick={() => access && setLearnMode(!on)}>
      <Lamp on={on} label={LEARN} />
      <SwitchName>{LEARN}</SwitchName>
      <SwitchState className={cls({ on: on && access })}>{state()}</SwitchState>
    </Switch>
  );
};

// the bindings by CC: its control, × removes it; Clear all of them
const BindingList = ({
  module: [{ $bindings, $names, targets }, { remove, clear }],
}: Pick<Props, 'module'>) => {
  const bindings = useBehaviorSubject($bindings);
  // (a name of a control changes: a macro renamed, the type of the filter)
  useObservable($names, null);
  const rows = Object.entries(bindings)
    .map(([cc, id]) => ({ cc: Number(cc), id, name: targets.get(id)?.name() ?? id }))
    .sort((a, b) => a.cc - b.cc);
  return (
    <>
      <Row>
        <GroupLabel>Bindings</GroupLabel>
        <ClearAll disabled={rows.length === 0} onClick={clear}>
          Clear all
        </ClearAll>
      </Row>
      {rows.length === 0 ? (
        <PopoverNote>
          None. Right-click a control for MIDI Learn, or switch it on here and press one.
        </PopoverNote>
      ) : (
        <Bindings aria-label='MIDI bindings'>
          {rows.map(({ cc, id, name }) => (
            <Binding key={cc}>
              <Cc>CC {cc}</Cc>
              <Name>{name}</Name>
              <Remove aria-label={`Remove CC ${cc} of ${name}`} onClick={() => remove(id)}>
                <CloseOutlined aria-hidden />
              </Remove>
            </Binding>
          ))}
        </Bindings>
      )}
    </>
  );
};

const TakeoverKeys = ({ module: [{ $takeover }, { setTakeover }] }: Pick<Props, 'module'>) => (
  <Row>
    <GroupLabel>Takeover</GroupLabel>
    <div style={{ marginLeft: 'auto' }}>
      <ChoiceKeys
        aria-label='Takeover'
        options={TAKEOVER_OPTIONS}
        value={useBehaviorSubject($takeover)}
        onChange={setTakeover}
      />
    </div>
  </Row>
);

interface Props {
  module: MidiLearnModule;
  // the browser has MIDI (WebMIDI, its permission)
  access: boolean;
}

// MIDI Learn in the Midi panel: its mode, how a knob takes its CC, the bindings of the browser (not kept where it
// keeps no site data). None without the model of MIDI Learn
export const MidiLearnGroup = ({ access }: Pick<Props, 'access'>) => {
  const module = React.useContext(MidiLearnModelContext);
  if (!module) return null;
  return (
    <PopoverGroup>
      <LearnSwitch module={module} access={access} />
      <TakeoverKeys module={module} />
      <BindingList module={module} />
      {!module[0].kept && <PopoverNote>Not kept: this browser keeps no site data.</PopoverNote>}
    </PopoverGroup>
  );
};

const NOT_LEARNING = new BehaviorSubject(false);

// the Learn mode is on (the key of the Midi panel shows it while the panel is closed)
export const useLearnMode = () => {
  const module = React.useContext(MidiLearnModelContext);
  return useBehaviorSubject(module?.[0].$learnMode ?? NOT_LEARNING);
};
