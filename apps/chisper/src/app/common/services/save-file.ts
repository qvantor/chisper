// how long the URL of a file saved is kept: a browser may read it well after the click (Safari, a Firefox that
// asks where to save it first), a .wav of a render may be large (FileSaver.js keeps it as long)
export const REVOKE_MS = 40_000;

// a file the browser saves (its downloads), named `name`
export const saveFile = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
};
