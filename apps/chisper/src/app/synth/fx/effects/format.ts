export const formatMs = (value: number) => `${Math.round(value * 1000)}ms`;

export const formatHz = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}kHz` : `${Math.round(value)}Hz`;

export const formatSeconds = (value: number) => (value < 1 ? formatMs(value) : `${value.toFixed(1)}s`);

export const formatDb = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}dB`;

// milliseconds as they are: under 10 with a decimal, a second and up in seconds
export const formatMillis = (value: number) => {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return value < 10 ? `${value.toFixed(1)}ms` : `${Math.round(value)}ms`;
};
