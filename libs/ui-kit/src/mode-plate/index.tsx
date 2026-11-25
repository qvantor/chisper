import React from 'react';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { css, styled } from 'styled-components';
import { Tooltip } from 'antd';
import { theme } from '../common/constants';
import { text10, textBold12 } from '../common/styles';
import { keepFocus } from '../common/utils';
import { MenuPanel } from '../control-menu';
import { knobGeometry } from '../handle';
import { useMidiAttrs } from '../midi-learn';
import { keyTip, TIP_DELAY, TIP_STYLES } from '../switch-key';

export interface ModeOption<T> {
  id: T;
  label: string;
  // its glyph in currentColor (28 × 20)
  icon: React.ReactNode;
  // what it does, under its name in the menu
  hint?: string;
  // the mode that does nothing (Off): the plate unlit
  off?: boolean;
}

interface Props<T> {
  // the name of the choice (Warp mode): the header of the menu, the tooltip, screen readers
  name: string;
  options: ModeOption<T>[];
  value: T;
  onChange: (id: T) => void;
  // what the plate does, under its name in the tooltip
  hint?: string;
  // narrow: the glyph alone (the name in the tooltip and the menu)
  compact?: boolean;
  className?: string;
  // its id of MIDI Learn (a CC chooses a mode)
  midiTarget?: string;
}

// the box of a knob of the size beside it
const KNOB_BOX = knobGeometry('m').box;
const LIT_BACKGROUND = `linear-gradient(${hexToRgba(theme.colors.accent, 0.1)}, ${hexToRgba(theme.colors.accent, 0.1)})`;
// the faint edge of the items of the menu, a little darker under the pointer
const EDGE = `inset 0 0 0 1px ${hexToRgba(theme.colors.primaryDarkMediumContrast, 0.1)}`;
const EDGE_HOVER = `inset 0 0 0 1px ${hexToRgba(theme.colors.primaryDarkMediumContrast, 0.18)}`;

const Glyph = styled.span`
  display: flex;
  transition: filter 150ms;

  svg {
    display: block;
    width: 28px;
    height: 20px;
  }
`;

// the glyph of the current mode, on the plate and in the menu
const litGlyph = css`
  color: ${theme.colors.accent};
  filter: drop-shadow(0 0 3px ${hexToRgba(theme.colors.accent, 0.6)});
`;

// on the plate in a box as high as the box of a knob: level with the face of the knob beside it
const GlyphBox = styled(Glyph)`
  flex: none;
  align-items: center;
  justify-content: center;
  height: ${KNOB_BOX}px;
`;

// the name and the caret of the menu under the glyph, in the rest of the height: level with the label of the knob
const NameRow = styled.span`
  flex: 1 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-height: 12px;
`;

const Label = styled.span`
  font-size: 11px;
  line-height: 1;
  font-weight: 600;
  white-space: nowrap;
`;

const Caret = styled.span`
  flex: none;
  border-top: 4px solid currentColor;
  border-left: 3px solid transparent;
  border-right: 3px solid transparent;
  opacity: 0.6;
`;

// flat on the panel, as high as what it stands in (a knob with its label: at least the box of a knob): the glyph of
// the mode level with the face of the knob, its name and the caret of the menu level with the label; grey while the
// mode does nothing (as the knob), its glyph lit while it does; tinted under the pointer and while its menu is open
const Plate = styled.button`
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 52px;
  min-height: ${KNOB_BOX}px;
  padding: 0;
  border: none;
  border-radius: ${theme.borderRadius.m};
  background-color: transparent;
  color: ${theme.colors.primaryMediumContrast};
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    color 150ms,
    background-color 150ms;

  &.compact {
    width: 30px;
  }

  &:hover,
  &[aria-expanded='true'] {
    background-color: ${hexToRgba(theme.colors.primaryDarkMediumContrast, 0.06)};
  }

  &.lit {
    color: ${theme.colors.primaryDarkMediumContrast};
  }

  &.lit ${Glyph} {
    ${litGlyph};
  }

  &:focus {
    outline: none;
  }
`;

const Items = styled.div`
  display: flex;
  flex-direction: column;
  gap: 3px;
`;

// light keys on the panel of the menu, the edge of the plate: the current one tinted and lit
const Item = styled.button`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: none;
  border-radius: ${theme.borderRadius.m};
  background-color: ${theme.colors.white};
  box-shadow: ${EDGE};
  color: ${theme.colors.primaryDarkMediumContrast};
  text-align: left;
  cursor: pointer;
  transition: box-shadow 150ms;
  -webkit-tap-highlight-color: transparent;

  ${Glyph} {
    flex: none;
    color: ${theme.colors.primaryMediumContrast};
  }

  /* larger than on the plate: the modes side by side */
  ${Glyph} svg {
    width: 34px;
    height: 24px;
  }

  &:hover {
    box-shadow: ${EDGE_HOVER};
  }

  &.on {
    background-image: ${LIT_BACKGROUND};
  }

  &.on ${Glyph} {
    ${litGlyph};
  }

  &:focus {
    outline: none;
  }

  @media (pointer: coarse) {
    padding: 8px;
  }
`;

const ItemText = styled.span`
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
`;

const ItemLabel = styled.span`
  ${textBold12};
  line-height: 14px;
`;

const ItemHint = styled.span`
  ${text10};
  line-height: 12px;
  color: ${theme.colors.primaryHighContrast};
`;

// the mode of a knob on a plate beside it: its glyph and its name, a press opens the menu of the modes under it
// (each its glyph, its name and what it does, the current one lit), a mode chosen closes it
export const ModePlate = <T,>({
  name,
  options,
  value,
  onChange,
  hint,
  compact = false,
  className,
  midiTarget,
}: Props<T>) => {
  const plateRef = React.useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
  const close = React.useCallback(() => setAnchor(null), []);
  const current = options.find((option) => option.id === value) ?? options[0];
  const open = anchor !== null;

  const midi = useMidiAttrs(midiTarget);
  const toggle = () => {
    const plate = plateRef.current;
    setAnchor(open || !plate ? null : plate.getBoundingClientRect());
  };

  return (
    <>
      <Tooltip
        mouseEnterDelay={TIP_DELAY / 1000}
        styles={TIP_STYLES}
        title={keyTip(name, hint)}
        open={open ? false : undefined}
      >
        <Plate
          ref={plateRef}
          type='button'
          className={cls(className, { lit: !current.off, compact })}
          aria-label={name}
          aria-haspopup='menu'
          aria-expanded={open}
          // no focus, nor does a press move it: the keys stay those of the notes
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={toggle}
          {...midi}
        >
          <GlyphBox>{current.icon}</GlyphBox>
          <NameRow>
            {!compact && <Label>{current.label}</Label>}
            <Caret />
          </NameRow>
        </Plate>
      </Tooltip>
      {anchor && (
        <MenuPanel
          anchor={anchor}
          onClose={close}
          name={name}
          value={current.label}
          keepOpenOn={plateRef}
          role='menu'
        >
          <Items>
            {options.map((option) => {
              const on = option.id === value;
              return (
                <Item
                  key={String(option.id)}
                  type='button'
                  role='menuitemradio'
                  aria-checked={on}
                  aria-label={option.label}
                  className={cls({ on })}
                  tabIndex={-1}
                  onClick={() => {
                    onChange(option.id);
                    close();
                  }}
                >
                  <Glyph>{option.icon}</Glyph>
                  <ItemText>
                    <ItemLabel>{option.label}</ItemLabel>
                    {option.hint && <ItemHint>{option.hint}</ItemHint>}
                  </ItemText>
                </Item>
              );
            })}
          </Items>
        </MenuPanel>
      )}
    </>
  );
};
