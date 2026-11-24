import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import {
  BandPassIcon,
  HighPassIcon,
  keepFocus,
  LowPassIcon,
  NotchPeakIcon,
  SwitchKey,
  SwitchKeys,
  text10,
  textBold12,
  theme,
} from '@chisper/ui-kit';
import { BrowserKey } from '../../../../common/components';
import { FILTER_TYPE_NAMES, filterTypeBrowser, typeInCategory } from '../../../filter/filter-types';
import { FX_FILTER_TYPES, fxFilterIndexOf, FxFilterType } from '../../effects/fxfilter-params';
import { FRAME_SIZE } from './screen-grip';
import { FxControlsProps } from './types';

// the types by category (those of the filter of a voice the FX Filter has)
const { options, categories, pathOf } = filterTypeBrowser(FX_FILTER_TYPES);
const categoryOf = (type: FxFilterType) =>
  categories.find(({ types }) => types.includes(type)) ?? categories[0];

// the key of each category: its glyph (the response of its types), what they do
const KEYS: Record<string, { icon: React.ReactNode; hint: string }> = {
  'low-pass': { icon: <LowPassIcon />, hint: 'Cuts the highs over the cutoff' },
  'high-pass': { icon: <HighPassIcon />, hint: 'Cuts the lows under the cutoff' },
  'band-pass': { icon: <BandPassIcon />, hint: 'Keeps a band around the cutoff' },
  'notch-peak': { icon: <NotchPeakIcon />, hint: 'Cuts a narrow band at the cutoff, or lifts it' },
};

const LINE = `1px solid ${theme.colors.primaryDarkMediumContrast}`;

// one dark plate as high as the screen beside it (as the switch of a mode of the EQ is): the keys of the categories
// over the strip of the type; bypassed, faded as a whole
const Plate = styled.div`
  flex: none;
  display: flex;
  flex-direction: column;
  width: 96px;
  height: ${FRAME_SIZE[1]}px;
  overflow: hidden;
  border-radius: ${theme.borderRadius.m};
  background: ${theme.colors.primaryDark};
  transition: opacity 150ms;

  &.disabled {
    opacity: 0.5;
  }
`;

// two a row, in the rest of the height; faded with the plate, not again
const Categories = styled(SwitchKeys)`
  flex: 1 1 0;
  min-height: 0;
  height: auto;
  border-radius: 0;

  &[aria-disabled='true'] {
    opacity: 1;
  }
`;

// the name of the type between ◀ ▶, a line over them
const Strip = styled.div`
  flex: none;
  display: flex;
  height: 20px;
  border-top: ${LINE};
`;

// a press takes no focus (the keys of the keyboard still play)
const Arrow = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${text10};
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: ${theme.colors.white};
  cursor: pointer;
  transition: background 150ms;

  &:hover {
    background: ${theme.colors.primaryDarkHighContrast};
  }

  &:active {
    background: ${theme.colors.primaryDarkMediumContrast};
  }

  &:disabled {
    cursor: default;
    pointer-events: none;
  }
`;

// the name between the arrows, centered, cut in its middle where it doesn't fit
const Name = styled(BrowserKey)`
  ${textBold12};
  flex: 1 1 0;
  padding: 0 2px;
  letter-spacing: 0.3px;
`;

// bypassed (not `on`): nothing of it is pressed
interface Props extends Pick<FxControlsProps, 'on' | 'setParam'> {
  type: FxFilterType;
}

// The type of the FX Filter on a plate left of its screen: a key a category (lit: the one of the type; pressed, the
// type chosen in it last, else the one of the slope of the type now, else its first), under them the name of the type
// between ◀ ▶ (through the types of its category, around), a click on the name opens the browser of all the types by
// category (the one of the filter of a voice). Memoized: the controls render on every move of a knob, a key is a
// tooltip
export const FxFilterTypePlate = React.memo(({ type, on, setParam }: Props) => {
  const disabled = !on;
  const setType = (next: FxFilterType) => setParam('type', fxFilterIndexOf(next));
  const category = categoryOf(type);
  // the type chosen last in each category, while the panel shows the filter (a preset, an undo too)
  const last = React.useRef<Partial<Record<string, FxFilterType>>>({});
  React.useEffect(() => {
    last.current[category.value] = type;
  }, [category, type]);
  const step = (delta: number) => () => {
    const { types } = category;
    setType(types[(types.indexOf(type) + delta + types.length) % types.length]);
  };
  return (
    <Plate className={cls({ disabled })} role='group' aria-label='Filter type'>
      <Categories aria-label='Category' disabled={disabled} disabledHint='Turn on the FX Filter' grid>
        {categories.map(({ value, label, types }) => {
          const { icon, hint } = KEYS[value];
          return (
            <SwitchKey
              key={value}
              icon={icon}
              name={label}
              hint={hint}
              on={value === category.value}
              onChange={() => {
                if (value !== category.value) setType(last.current[value] ?? typeInCategory(types, type));
              }}
            />
          );
        })}
      </Categories>
      <Strip>
        <Arrow aria-label='Previous' disabled={disabled} onClick={step(-1)}>
          <LeftOutlined />
        </Arrow>
        <Name
          options={options}
          value={pathOf(type)}
          setValue={(path) => setType(path[path.length - 1] as FxFilterType)}
          label={FILTER_TYPE_NAMES[type]}
          title='Filter type'
          status='success'
          disabled={disabled}
        />
        <Arrow aria-label='Next' disabled={disabled} onClick={step(1)}>
          <RightOutlined />
        </Arrow>
      </Strip>
    </Plate>
  );
});
