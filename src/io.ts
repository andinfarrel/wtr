import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { red } from "./ansi.ts";

export function err(msg: string): void {
  writeSync(2, msg + "\n");
}

export function fail(msg: string): never {
  err(`${red("wtr:")} ${msg}`);
  process.exit(1);
}

export function emitCd(path: string): void {
  writeSync(1, path + "\n");
}

export function promptTty(question: string): string | null {
  process.stderr.write(question);
  let fd: number;
  try {
    fd = openSync("/dev/tty", "rs");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, null);
    return buf.toString("utf8", 0, n).replace(/[\r\n]+$/, "");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
