import React from 'react';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { FileSelect, SelectProgress } from '../../../common/components';
import { useNoise } from '../../common/modules';
import { sampleName, useNoiseSamples } from '../hooks/use-noise-samples';

// the label of a path (folders, then the key of a sample): the name of its sample, as its option has it, also where
// the list hasn't it (not loaded yet, a sample gone from it)
export const pathLabel = (path: (string | number)[]): string => {
  const key = path[path.length - 1];
  return key === undefined ? '' : sampleName(String(key));
};

const SampleProgress = () => {
  const [{ $sampleProgress }] = useNoise();
  return <SelectProgress progress={useBehaviorSubject($sampleProgress)} />;
};

// the sample of the noise, by category; ◀ ▶ through all of them
export const NoiseSelector = () => {
  const { options: samples, status } = useNoiseSamples();
  const [{ $samplePath }, { setSamplePath }] = useNoise();
  const path = useBehaviorSubject($samplePath);
  return (
    <FileSelect
      options={samples}
      value={path}
      setValue={setSamplePath}
      progress={<SampleProgress />}
      label={pathLabel(path)}
      title='Noise'
      status={status}
    />
  );
};
