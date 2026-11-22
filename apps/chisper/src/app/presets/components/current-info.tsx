import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { text10, text12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { categoryPath, tagLabel } from '@chisper/preset-schema';
import { SCREEN_LINE, screenScrollStyle } from '../../common/components';
import { usePresets } from '../modules/presets';
import { NARROW } from './preset-keys';

const { colors } = theme;

// the strip under the list, a hairline over it: as high whatever it tells (the dialog doesn't jump between presets),
// the rest of a long description scrolled (a phone)
const Strip = styled.section`
  ${screenScrollStyle};
  flex: none;
  height: 72px;
  padding: 6px 10px;
  border-top: ${SCREEN_LINE};

  ${NARROW} {
    height: 96px;
  }
`;

// its first line: what it is, the keys of the preset on the right (on a phone alone: a row there has none)
const Head = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
`;

const Keys = styled.div`
  flex: none;
  display: none;
  margin-left: auto;

  ${NARROW} {
    display: flex;
  }
`;

// its category and subcategory in the blue of the labels of the screen, its tags after them
const Meta = styled.div`
  ${text10};
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  column-gap: 12px;
  line-height: 16px;
  color: ${colors.primaryDarkHighContrast};
`;

const Category = styled.span`
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
`;

const Description = styled.p`
  ${text12};
  margin: 0;
  line-height: 16px;
  color: ${colors.white};
  overflow-wrap: anywhere;

  &.none {
    color: ${hexToRgba(colors.primaryDarkHighContrast, 0.7)};
  }
`;

// what the author tells of the preset opened (in any list, or none): its category, its tags, its description; its
// `keys` on a phone
export const CurrentInfo = ({ keys }: { keys?: React.ReactNode }) => {
  const [{ $currentInfo }] = usePresets();
  const info = useBehaviorSubject($currentInfo);
  const category = info?.category && categoryPath(info.category, info.subcategory);
  const tags = info?.tags.map(tagLabel).join(' · ');
  return (
    <Strip aria-label='Preset info'>
      {(category || tags || keys) && (
        <Head>
          {(category || tags) && (
            <Meta>
              {category && <Category>{category}</Category>}
              {tags && <span>{tags}</span>}
            </Meta>
          )}
          {keys && <Keys>{keys}</Keys>}
        </Head>
      )}
      {info?.description ? (
        <Description>{info.description}</Description>
      ) : (
        <Description className='none'>No description</Description>
      )}
    </Strip>
  );
};
