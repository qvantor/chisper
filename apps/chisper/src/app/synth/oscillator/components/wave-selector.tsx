import React from 'react';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { FileOption, FileSelect, isFolder, SelectProgress } from '../../../common/components';
import { useWavetables, useOscillatorContext } from '../hooks';

const TableProgress = () => {
  const [{ $tableProgress }] = useOscillatorContext();
  return <SelectProgress progress={useBehaviorSubject($tableProgress)} />;
};

// the table of the oscillator, by pack and category; ◀ ▶ through all of them
export const WaveSelector = () => {
  const { options: wavetables, status } = useWavetables();
  const [{ $waveTablePath }, { setWaveTablePath }] = useOscillatorContext();
  const waveTablePath = useBehaviorSubject($waveTablePath);
  // the label of the last option found down the path (a key the list hasn't is passed over), until then Loading...
  const label = React.useMemo(() => {
    let level: FileOption[] | undefined = wavetables;
    let found = 'Loading...';
    for (const key of waveTablePath) {
      const option: FileOption | undefined = level?.find((other) => other.value === key);
      if (!option) continue;
      found = option.label;
      level = isFolder(option) ? option.children : undefined;
    }
    return found;
  }, [waveTablePath, wavetables]);

  return (
    <FileSelect
      options={wavetables}
      value={waveTablePath}
      setValue={setWaveTablePath}
      progress={<TableProgress />}
      label={label}
      title='Wavetable'
      status={status}
    />
  );
};
