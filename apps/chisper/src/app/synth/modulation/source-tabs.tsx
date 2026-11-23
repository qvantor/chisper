import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import { distinctUntilChanged, map } from 'rxjs';
import { MdDragIndicator } from 'react-icons/md';
import { ModSource } from '@chisper/preset-schema';
import { startModDrag, theme } from '@chisper/ui-kit';
import { useBehaviorSubject, useObservable } from '@chisper/rxjs-react';
import { ModRoute } from '../common/modules/modulation';
import { useEnvelopes, useModulation } from '../common/modules';
import { bipolarByDefault } from '../common/modulation/modulation-targets';
import { FilterContext } from '../filter/modules';
import { SOURCE_COLORS, SOURCE_LABELS } from '../envelope/envelope-colors';

// the whole header (a plain one): a segmented control on its grey, as high as the other headers
const Root = styled.div`
  flex: 1 1;
  min-width: 0;
  display: flex;
  gap: 2px;
  padding: 2px;
`;

// an equal share of the header each, its label white as the titles of the other headers, after a dot of the color
// of its source (the color of its routes on the knobs). The selected one is a white key with a dark label, the one
// a section shows while another section's is selected a translucent one
const Tab = styled.button`
  flex: 1 1 0;
  min-width: 0;
  height: 17px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font: inherit;
  color: ${theme.colors.white};
  background: none;
  border: none;
  border-radius: 2px;
  padding: 0 6px;
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  transition:
    background 120ms,
    color 120ms;

  &:hover {
    background: rgba(255, 255, 255, 0.25);
  }

  &.selected {
    color: ${theme.colors.primaryDarkMediumContrast};
    background: ${theme.colors.white};
    box-shadow: 0 1px 1px rgba(0, 0, 0, 0.12);
    cursor: grab;
  }

  &.shown {
    color: ${theme.colors.primaryDarkMediumContrast};
    background: rgba(255, 255, 255, 0.55);
  }

  /* never an outline: the selected one is a white key */
  &:focus,
  &:focus-visible {
    outline: none;
  }
`;

// a white ring around it (the colors are about as dark as the grey of the header), the number of the routes of
// its source in it (none: empty)
const Dot = styled.span`
  flex: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px ${theme.colors.white};
  font-size: 9px;
  font-weight: 700;
  line-height: 13px;
  text-align: center;
  color: ${theme.colors.white};
`;

// the grip of the selected tab, in its right corner: the label stays centered
const Grip = styled(MdDragIndicator)`
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 13px;
  color: ${theme.colors.primaryMediumContrast};
`;

type TabAttributes = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'id' | 'onSelect' | 'children'>;

interface SourceTabProps<S extends ModSource> extends TabAttributes {
  id: S;
  // it is the selected source (the knobs show its routes): a white key with the grip
  selected: boolean;
  // the section shows it while another source is selected: a translucent key
  shown?: boolean;
  // selected (or dropped on a knob)
  onSelect: (id: S) => void;
  // the knobs its source goes to (all by default): the others don't light up while it is dragged
  accepts?: (target: string) => boolean;
  // what it says (the label of its source by default)
  children?: React.ReactNode;
  // the grip of the selected one (a tab too narrow for it: none, its white key tells it)
  grip?: boolean;
}

// the number of the routes of `source`
const routeCount = (source: ModSource, routes: ModRoute[]) =>
  routes.filter((route) => route.source === source).length;

// the tab of a source: a click selects it, dragged onto a knob it assigns its source to it at +50% (an LFO or a
// macro bipolar on a knob centered on 0: Var of an EQ type by the type of the filter) and selects it, the knobs show
// the new route at once; the dot has the number of the routes of its source (a route added or removed renders the
// tab, not an amount), the grip of the selected one tells it
export const SourceTab = <S extends ModSource>({
  id,
  selected,
  shown,
  onSelect,
  accepts,
  children,
  grip = true,
  className,
  ...attributes
}: SourceTabProps<S>) => {
  const [{ $routes }, { addRoute }] = useModulation();
  const filter = React.useContext(FilterContext)?.[0];
  const $count = React.useMemo(
    () =>
      $routes.pipe(
        map((routes) => routeCount(id, routes)),
        distinctUntilChanged()
      ),
    [$routes, id]
  );
  const count = useObservable($count, routeCount(id, $routes.value));
  return (
    <Tab
      type='button'
      {...attributes}
      className={cls(className, { selected, shown: shown && !selected })}
      onClick={() => onSelect(id)}
      onPointerDown={(e) =>
        startModDrag(e, {
          label: SOURCE_LABELS[id],
          color: SOURCE_COLORS[id],
          accepts,
          onDrop: (target) => {
            addRoute(id, target, undefined, bipolarByDefault(id, target, filter?.$filterType.value));
            onSelect(id);
          },
        })
      }
    >
      <Dot aria-hidden data-testid='route-count' style={{ background: SOURCE_COLORS[id] }}>
        {count || null}
      </Dot>
      {children ?? SOURCE_LABELS[id]}
      {selected && grip && <Grip aria-hidden data-testid='env-grip' />}
    </Tab>
  );
};

interface Props<S extends ModSource> {
  // the accessible name of the tabs
  label: string;
  sources: readonly S[];
  // the tab of the source the section shows (the ENV section: the last envelope selected), a translucent key while
  // another source is selected; without it the section shows each of its sources (VELO)
  shown?: S;
  // a tab was selected (or dropped on a knob): the section shows it
  onSelect?: (id: S) => void;
  // the knobs its sources go to (all by default): the others don't light up while one is dragged
  accepts?: (target: string) => boolean;
}

// the tabs of sources in the header of a section, ENV 1 | ENV 2 | ENV 3, VELO or LFO 1 | … | LFO 4 (SourceTab each):
// the selected one (of every source, the tabs of the other sections too) is the source the knobs show the routes of
export const SourceTabs = <S extends ModSource>({ label, sources, shown, onSelect, accepts }: Props<S>) => {
  const [{ $selected }, { select: selectSource }] = useEnvelopes();
  const selected = useBehaviorSubject($selected);
  const select = (id: S) => {
    selectSource(id);
    onSelect?.(id);
  };
  return (
    <Root role='tablist' aria-label={label}>
      {sources.map((id) => (
        <SourceTab
          key={id}
          id={id}
          role='tab'
          // the tab of what the section shows: one of each tablist
          aria-selected={shown === undefined || id === shown}
          selected={id === selected}
          shown={id === shown}
          onSelect={select}
          accepts={accepts}
        />
      ))}
    </Root>
  );
};
