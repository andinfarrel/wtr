import { homedir } from "node:os";

export function shorten(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + "/")
    ? "~" + p.slice(home.length)
    : p;
}

export function folderName(branch: string): string {
  return branch.replace(/\//g, "-");
}
