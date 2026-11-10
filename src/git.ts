import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import { fail } from "./io.ts";

export type Worktree = { path: string; branch: string; detached: boolean };
export type GitResult = { status: number; stdout: string; stderr: string };

export function git(args: string[]): GitResult {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

export function gitRun(args: string[]): number {
  const r = spawnSync("git", args, { stdio: ["inherit", 2, "inherit"] });
  return r.status ?? 1;
}

export function gitOk(args: string[]): boolean {
  return git(args).status === 0;
}

export function inRepo(): boolean {
  return gitOk(["rev-parse", "--git-dir"]);
}

export function requireRepo(): void {
  if (!inRepo()) fail("not in a git repo");
}

export function repoName(): string {
  const url = git(["config", "--get", "remote.origin.url"]).stdout.trim();
  if (url) return basename(url.replace(/\.git$/, ""));
  return basename(git(["rev-parse", "--show-toplevel"]).stdout.trim());
}

const WORKTREE_PREFIX = "worktree ";
const BRANCH_PREFIX = "branch refs/heads/";

/** Parse the output of `git worktree list --porcelain` into worktrees.
 * Records are separated by blank lines; each holds a `worktree <path>` line
 * plus optional `branch refs/heads/<name>` or `detached` markers. */
export function parseWorktrees(raw: string): Worktree[] {
  return raw
    .split("\n\n")
    .map((record) => record.split("\n"))
    .map((lines): Worktree | null => {
      const pathLine = lines.find((l) => l.startsWith(WORKTREE_PREFIX));
      if (!pathLine) return null;
      const branchLine = lines.find((l) => l.startsWith(BRANCH_PREFIX));
      const detached = lines.includes("detached");
      const branch = branchLine
        ? branchLine.slice(BRANCH_PREFIX.length)
        : detached
          ? "(detached)"
          : "?";
      return { path: pathLine.slice(WORKTREE_PREFIX.length), branch, detached };
    })
    .filter((w): w is Worktree => w !== null);
}

export function listWorktrees(): Worktree[] {
  return parseWorktrees(git(["worktree", "list", "--porcelain"]).stdout);
}

export type WorktreeStatus = "clean" | "dirty" | "unknown";

export type StatusScan = {
  done: Promise<void>;
  prioritize: (paths: string[]) => void;
  cancel: () => void;
};

export function scanStatuses(
  paths: string[],
  onStatus: (path: string, status: WorktreeStatus) => void,
  options: { concurrency?: number; timeout?: number } = {},
): StatusScan {
  const controller = new AbortController();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  let pending = [...new Set(paths)];
  let active = 0;
  let complete: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });

  const pump = (): void => {
    while (
      !controller.signal.aborted &&
      active < concurrency &&
      pending.length
    ) {
      const path = pending.shift()!;
      active++;
      let dirty = false;
      let failed = false;
      const child = spawn("git", ["-C", path, "status", "--porcelain"], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: options.timeout ?? 10_000,
        signal: controller.signal,
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.length) dirty = true;
      });
      child.on("error", () => {
        failed = true;
      });
      child.on("close", (code) => {
        active--;
        if (!controller.signal.aborted) {
          onStatus(
            path,
            failed || child.killed || code !== 0
              ? "unknown"
              : dirty
                ? "dirty"
                : "clean",
          );
        }
        pump();
      });
    }
    if (!active && (!pending.length || controller.signal.aborted)) complete();
  };

  queueMicrotask(pump);
  return {
    done,
    prioritize: (paths) => {
      const priority = new Set(paths);
      pending = [
        ...pending.filter((path) => priority.has(path)),
        ...pending.filter((path) => !priority.has(path)),
      ];
    },
    cancel: () => {
      controller.abort();
      pending = [];
      if (!active) complete();
    },
  };
}
