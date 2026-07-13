const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;

export const paint = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = (s: string): string => paint("1", s);
export const dim = (s: string): string => paint("2", s);
export const red = (s: string): string => paint("31", s);
export const green = (s: string): string => paint("32", s);
export const yellow = (s: string): string => paint("33", s);
export const cyan = (s: string): string => paint("36", s);
