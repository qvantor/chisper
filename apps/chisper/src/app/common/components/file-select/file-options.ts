// the files of a bucket in their folders (the wavetables by pack and category, the noises by category): a folder
// its name as its value, a file its key; a path is the values from the top down to a file
type FileFolder = { value: string; label: string; children: FileOption[] };
// its note: what is shown on the right of its row (the size of a table)
type FileLeaf = { value: string; label: string; note?: string };
export type FileOption = FileFolder | FileLeaf;
export type FilePath = (string | number)[];

// the load of a list (the status of its query)
export type ListStatus = 'pending' | 'error' | 'success';

export const isFolder = (option: FileOption): option is FileFolder => 'children' in option;

// paths of the files in the order they are shown
export const leafPaths = (options: FileOption[], parent: string[] = []): string[][] =>
  options.flatMap((option) =>
    isFolder(option) ? leafPaths(option.children, [...parent, option.value]) : [[...parent, option.value]]
  );

// a folder alone on its level (the only wavetable pack) is chosen for the user: the browser starts inside it
export const skipSingleFolders = (
  options: FileOption[],
  prefix: string[] = []
): { prefix: string[]; options: FileOption[] } => {
  const [single] = options;
  if (options.length !== 1 || !isFolder(single)) return { prefix, options };
  return skipSingleFolders(single.children, [...prefix, single.value]);
};

// the files under an option, at any depth (1 for a file)
export const fileCount = (option: FileOption): number =>
  isFolder(option) ? option.children.reduce((count, child) => count + fileCount(child), 0) : 1;

// the levels of folders over the deepest file (0: the files alone)
export const folderDepth = (options: FileOption[]): number =>
  options.reduce(
    (depth, option) => (isFolder(option) ? Math.max(depth, 1 + folderDepth(option.children)) : depth),
    0
  );

// the folder of a level by its value
const folderIn = (level: FileOption[], key: string | number) =>
  level.find((option): option is FileFolder => isFolder(option) && option.value === key);

// the first values of a path are those of another
export const startsWith = (path: FilePath, start: FilePath) => start.every((key, i) => path[i] === key);

// the options of each column: the top level, then the children of each folder of a path, up to one it has not
export const columnsOf = (options: FileOption[], path: FilePath): FileOption[][] => {
  const columns = [options];
  for (const key of path) {
    const folder = folderIn(columns[columns.length - 1], key);
    if (!folder) break;
    columns.push(folder.children);
  }
  return columns;
};

// the folders opened to show a path: those of it in the list, then the first folder of each level that has no file
// (a pack opens its first category; a path the list hasn't, its first folder)
export const openFolders = (options: FileOption[], path: FilePath): string[] => {
  const columns = columnsOf(options, path);
  const opened = path.slice(0, columns.length - 1).map(String);
  let level = columns[columns.length - 1];
  while (level.length > 0 && level.every(isFolder)) {
    opened.push(level[0].value);
    level = level[0].children;
  }
  return opened;
};
