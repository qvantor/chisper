import React from 'react';
import { chosenId, usePresets } from '../../presets';

// the preset a link of the clip opens with: the one chosen while its sound is unchanged, as the preset puts itself in
// the url (none for the one opened on start, nor Init)
export const useLinkPreset = () => {
  const [{ $current, $dirty }] = usePresets();
  return React.useCallback(() => ($dirty.value ? null : chosenId($current.value)), [$current, $dirty]);
};
