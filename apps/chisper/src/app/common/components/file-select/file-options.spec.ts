import {
  columnsOf,
  fileCount,
  FileOption,
  folderDepth,
  leafPaths,
  openFolders,
  skipSingleFolders,
} from './file-options';

const options: FileOption[] = [
  {
    value: 'A',
    label: 'A',
    children: [
      { value: 'A/1.wav', label: '1' },
      { value: 'A/2.wav', label: '2' },
    ],
  },
  { value: 'B', label: 'B', children: [{ value: 'B/1.wav', label: '1' }] },
];

// two packs of categories
const packs: FileOption[] = [
  { value: 'P', label: 'P', children: options },
  {
    value: 'Q',
    label: 'Q',
    children: [{ value: 'C', label: 'C', children: [{ value: 'Q/C/1.wav', label: '1' }] }],
  },
];

describe('leafPaths', () => {
  it('lists the paths of the files in the order they are shown, top files and nested ones', () => {
    expect(leafPaths([{ value: 'top.wav', label: 'top' }, ...options])).toEqual([
      ['top.wav'],
      ['A', 'A/1.wav'],
      ['A', 'A/2.wav'],
      ['B', 'B/1.wav'],
    ]);
  });
});

describe('skipSingleFolders', () => {
  it('skips nested single folders', () => {
    const nested = [
      { value: 'Pack', label: 'Pack', children: [{ value: 'Core', label: 'Core', children: options }] },
    ];
    expect(skipSingleFolders(nested)).toEqual({ prefix: ['Pack', 'Core'], options });
  });

  it('stops at a file', () => {
    const single = [{ value: 'Sine.wav', label: 'Sine' }];
    expect(skipSingleFolders([{ value: 'Pack', label: 'Pack', children: single }])).toEqual({
      prefix: ['Pack'],
      options: single,
    });
    expect(skipSingleFolders(single)).toEqual({ prefix: [], options: single });
  });

  it('keeps several folders, and an empty list', () => {
    expect(skipSingleFolders(options)).toEqual({ prefix: [], options });
    expect(skipSingleFolders([])).toEqual({ prefix: [], options: [] });
  });
});

describe('fileCount and folderDepth', () => {
  it('counts the files under a folder at any depth, a file as one', () => {
    expect(packs.map(fileCount)).toEqual([3, 1]);
    expect(fileCount({ value: 'x.wav', label: 'x' })).toBe(1);
    expect(fileCount({ value: 'Empty', label: 'Empty', children: [] })).toBe(0);
  });

  it('measures the levels of folders over the deepest file', () => {
    expect(folderDepth(packs)).toBe(2);
    expect(folderDepth(options)).toBe(1);
    expect(folderDepth([{ value: 'x.wav', label: 'x' }])).toBe(0);
    expect(folderDepth([])).toBe(0);
  });
});

describe('openFolders', () => {
  it('opens the folders of a path', () => {
    expect(openFolders(options, ['B', 'B/1.wav'])).toEqual(['B']);
    expect(openFolders(packs, ['Q', 'C', 'Q/C/1.wav'])).toEqual(['Q', 'C']);
  });

  it('opens the first folder of a level without files: a pack its first category', () => {
    expect(openFolders(packs, ['Q'])).toEqual(['Q', 'C']);
    expect(openFolders(packs, ['P'])).toEqual(['P', 'A']);
  });

  it('opens the first folders for a path the list has not, as far as it has it', () => {
    expect(openFolders(options, ['Gone', 'Gone/1.wav'])).toEqual(['A']);
    expect(openFolders(packs, ['P', 'Gone', 'P/Gone/1.wav'])).toEqual(['P', 'A']);
    expect(openFolders(options, [])).toEqual(['A']);
  });

  it('opens nothing over files, or in an empty list', () => {
    const mixed: FileOption[] = [{ value: 'top.wav', label: 'top' }, ...options];
    expect(openFolders(mixed, ['top.wav'])).toEqual([]);
    expect(openFolders([], ['A', 'A/1.wav'])).toEqual([]);
  });

  it('opens the folder of a value, not a file of its name', () => {
    const same: FileOption[] = [{ value: 'A', label: 'A file' }, ...options];
    expect(openFolders(same, ['A', 'A/1.wav'])).toEqual(['A']);
  });
});

describe('columnsOf', () => {
  it('gives the top level, then the children of each folder opened', () => {
    expect(columnsOf(packs, ['P', 'B'])).toEqual([packs, options, [{ value: 'B/1.wav', label: '1' }]]);
    expect(columnsOf(options, [])).toEqual([options]);
  });

  it('stops at a folder it has not', () => {
    expect(columnsOf(options, ['Gone', 'A'])).toEqual([options]);
  });
});
