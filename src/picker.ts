import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import * as readline from "node:readline";
import { bold, cyan, dim, yellow } from "./ansi.ts";
import { dirtySet, type Worktree } from "./git.ts";
import { fail } from "./io.ts";
import { shorten } from "./paths.ts";

export function hasFzf(): boolean {
  return spawnSync("fzf", ["--version"], { stdio: "ignore" }).status === 0;
}

export function pickWithFzf(items: Worktree[], prompt: string): string | null {
  const input = items.map((w) => `${w.branch}\t${w.path}`).join("\n");
  const preview =
    'git -C {2} log -1 --format="%C(auto)%h %s  %C(dim)(%cr)" 2>/dev/null; ' +
    "echo; git -C {2} status -s 2>/dev/null | head -20";
  const r = spawnSync(
    "fzf",
    [
      "--prompt",
      prompt,
      "--height",
      "40%",
      "--reverse",
      "--delimiter",
      "\t",
      "--with-nth",
      "1",
      "--nth",
      "1",
      "--header",
      "enter: switch   esc: cancel",
      "--preview",
      preview,
      "--preview-window",
      "down,50%,border-top",
    ],
    { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] },
  );
  if (r.status !== 0) return null;
  const sel = (r.stdout || "").trim();
  if (!sel) return null;
  return sel.split("\t")[1] || null;
}

const HINT = "↑/↓ move · type to filter · enter select · esc cancel";

/** Collapse a path to `~` then truncate with a leading `…` to fit `budget`. */
function clipPath(path: string, budget: number): string {
  const s = shorten(path);
  return s.length <= budget ? s : "…" + s.slice(s.length - budget + 1);
}

/** Case-insensitive substring match on branch names; fresh array when empty. */
function filterItems(items: Worktree[], query: string): Worktree[] {
  const q = query.toLowerCase();
  return q
    ? items.filter((w) => w.branch.toLowerCase().includes(q))
    : items.slice();
}

/** Wrap an index by `delta` within `[0, length)`. */
function wrapIndex(index: number, delta: number, length: number): number {
  return (index + delta + length) % length;
}

/** Scroll the window so the selected row stays visible. */
function scrollTop(sel: number, top: number, vis: number): number {
  if (sel < top) return sel;
  if (sel >= top + vis) return sel - vis + 1;
  return top;
}

type ViewState = {
  items: Worktree[];
  dirty: Set<string>;
  sel: number;
  top: number;
  query: string;
  prompt: string;
  width: number;
  cols: number;
  rows: number;
  pathBudget: number;
};

function buildView(s: ViewState): { lines: string[]; top: number } {
  const n = s.items.length;
  const count = `${n ? s.sel + 1 : 0}/${n}`;
  const room =
    s.prompt.length + s.query.length + count.length + HINT.length + 4;
  const header =
    `${bold(s.prompt)}${s.query}${dim("▌")}  ${dim(count)}` +
    (room <= s.cols ? `  ${dim(HINT)}` : "");
  if (n === 0) {
    return { lines: [header, dim("  (no matches)")], top: s.top };
  }
  const vis = Math.min(s.rows - 1, n);
  const top = scrollTop(s.sel, s.top, vis);
  const rows = s.items.slice(top, top + vis).map((w, j) => {
    const active = top + j === s.sel;
    const pointer = active ? cyan("❯ ") : "  ";
    const name = w.branch.padEnd(s.width);
    const label = active ? cyan(bold(name)) : bold(name);
    const marker = s.dirty.has(w.path) ? yellow(" ●") : "  ";
    return `${pointer}${label}${marker}  ${dim(clipPath(w.path, s.pathBudget))}`;
  });
  return { lines: [header, ...rows], top };
}

function renderFrame(lines: string[], drawn: number): string {
  const total = Math.max(drawn, lines.length);
  const cursorUp = drawn > 0 ? `\x1b[${drawn}A` : "";
  const body = Array.from(
    { length: total },
    (_, i) => `\r\x1b[2K${lines[i] ?? ""}\n`,
  ).join("");
  const back = total - lines.length;
  const cursorBack = back > 0 ? `\x1b[${back}A` : "";
  return cursorUp + body + cursorBack;
}

function clearFrame(drawn: number, maxDrawn: number): string {
  const clearRows = "\r\x1b[2K\n".repeat(maxDrawn);
  return `\x1b[${drawn}A${clearRows}\x1b[${maxDrawn}A\x1b[?25h`;
}

function isPrintable(str: string, key: readline.Key): boolean {
  return (
    Boolean(str) && str.length === 1 && str >= " " && !key.ctrl && !key.meta
  );
}

type PickerState = { query: string; filtered: Worktree[]; sel: number };

type KeyResult =
  | { type: "update"; state: PickerState }
  | { type: "select"; path: string }
  | { type: "cancel" }
  | { type: "exit" };

function initState(items: Worktree[]): PickerState {
  return { query: "", filtered: items.slice(), sel: 0 };
}

/** Re-derive state for a changed query: re-filter and reset the selection. */
function withQuery(items: Worktree[], query: string): PickerState {
  return { query, filtered: filterItems(items, query), sel: 0 };
}

/** Pure transition: map the current state + a keypress to the next state or a
 * terminal outcome. Unchanged keys return the same `state` reference so the
 * driver can skip a redraw. */
function reduce(
  state: PickerState,
  items: Worktree[],
  str: string,
  key: readline.Key,
): KeyResult {
  if (key.ctrl && key.name === "c") return { type: "exit" };
  const n = state.filtered.length;
  switch (key.name) {
    case "up":
      return n
        ? {
            type: "update",
            state: { ...state, sel: wrapIndex(state.sel, -1, n) },
          }
        : { type: "update", state };
    case "down":
      return n
        ? {
            type: "update",
            state: { ...state, sel: wrapIndex(state.sel, 1, n) },
          }
        : { type: "update", state };
    case "return":
    case "enter": {
      const chosen = state.filtered[state.sel];
      return chosen
        ? { type: "select", path: chosen.path }
        : { type: "update", state };
    }
    case "escape":
      return { type: "cancel" };
    case "backspace":
      return state.query
        ? { type: "update", state: withQuery(items, state.query.slice(0, -1)) }
        : { type: "update", state };
  }
  if (isPrintable(str, key)) {
    return { type: "update", state: withQuery(items, state.query + str) };
  }
  return { type: "update", state };
}

export function pickInteractive(
  items: Worktree[],
  dirty: Set<string>,
  prompt: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const width = Math.max(6, ...items.map((w) => w.branch.length));
    const cols = process.stderr.columns || 80;
    const rows = Math.max(3, (process.stderr.rows || 24) - 2);
    const pathBudget = Math.max(10, cols - (width + 7));

    let state = initState(items);
    let top = 0;
    let drawn = 0;
    let maxDrawn = 0;

    const render = (): void => {
      const view = buildView({
        items: state.filtered,
        dirty,
        sel: state.sel,
        top,
        query: state.query,
        prompt,
        width,
        cols,
        rows,
        pathBudget,
      });
      top = view.top;
      writeSync(2, renderFrame(view.lines, drawn));
      drawn = view.lines.length;
      maxDrawn = Math.max(maxDrawn, view.lines.length);
    };

    const teardown = (): void => {
      writeSync(2, clearFrame(drawn, maxDrawn));
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("keypress", onKey);
    };

    const onKey = (str: string, key: readline.Key): void => {
      if (!key) return;
      const result = reduce(state, items, str, key);
      switch (result.type) {
        case "exit":
          teardown();
          return process.exit(130);
        case "select":
          teardown();
          return resolve(result.path);
        case "cancel":
          teardown();
          return resolve(null);
        case "update":
          if (result.state !== state) {
            state = result.state;
            render();
          }
          return;
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    writeSync(2, "\x1b[?25l"); // hide cursor
    render();
    stdin.on("keypress", onKey);
  });
}

/** Choose a worktree: fzf when available, else the native arrow-key picker. */
export async function pickItems(
  items: Worktree[],
  prompt: string,
): Promise<string | null> {
  if (hasFzf()) return pickWithFzf(items, prompt);
  if (process.stdin.isTTY) {
    const dirty = await dirtySet(items.map((w) => w.path));
    return pickInteractive(items, dirty, prompt);
  }
  fail("no interactive terminal (install fzf or run inside a terminal)");
}
