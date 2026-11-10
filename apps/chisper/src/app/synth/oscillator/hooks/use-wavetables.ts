import React from 'react';
import { useQuery } from '@tanstack/react-query';
import prettyBytes from 'pretty-bytes';
import { FileOption } from '../../../common/components';
import { fetchList } from '../../services/fetch';

interface Wavetable {
  Key: string;
  Size: number;
}

type Element = Folder | Wavetable;

interface Folder {
  name: string;
  children: Element[];
}

// a table by its name, its size on the right of its row
export const wavetablesToOptions = (data: Element[]): FileOption[] =>
  data.map((wave) => {
    if ('Key' in wave) {
      const path = wave.Key.split('/');
      const [filename] = path[path.length - 1].split('.');
      return { value: wave.Key, label: filename, note: prettyBytes(wave.Size) };
    }
    return { value: wave.name, label: wave.name, children: wavetablesToOptions(wave.children) };
  });

// the tables as the options of a file select, the load of their list
export const useWavetables = () => {
  const { data, status } = useQuery<Element[]>({
    queryKey: ['wavetables'],
    queryFn: () => fetchList<Element>('/.netlify/functions/get-wavetables-list'),
    staleTime: 24 * 60 * 60 * 1000,
  });
  const options = React.useMemo(() => wavetablesToOptions(data ?? []), [data]);
  return { options, status };
};
