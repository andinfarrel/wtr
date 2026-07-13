import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bold, cyan, dim, green, yellow } from "./ansi.ts";
import { CALLER_PWD, WTR_ROOT } from "./config.ts";
import {
  dirtySet,
  git,
  gitOk,
  gitRun,
  listWorktrees,
  repoName,
  requireRepo,
} from "./git.ts";
import { emitCd, err, fail, promptTty } from "./io.ts";
import { folderName, shorten } from "./paths.ts";
import { pickItems } from "./picker.ts";

export async function cmdSwitch(): Promise<void> {
  requireRepo();
  const items = listWorktrees();
  if (!items.length) fail("no worktrees found");
  const target = await pickItems(items, "switch> ");
  if (target) emitCd(target);
}

type AddArgs = { branch: string; base: string };

/** Parse `add` arguments: the first positional is the branch; `-b`/`--from`
 * takes the following token as the base branch. */
function parseAddArgs(args: string[]): AddArgs {
  const parsed = args.reduce<AddArgs & { expectBase: boolean }>(
    (acc, a) => {
      if (acc.expectBase) return { ...acc, base: a, expectBase: false };
      if (a === "-b" || a === "--from") return { ...acc, expectBase: true };
      if (!acc.branch) return { ...acc, branch: a };
      return acc;
    },
    { branch: "", base: "", expectBase: false },
  );
  return { branch: parsed.branch, base: parsed.base };
}

type AddPlan = { addArgs: string[]; message: string };

/** Decide how to create the worktree: check out an existing local branch,
 * track a matching remote branch, or create a fresh branch (off `base`). */
function resolveAddPlan(branch: string, base: string, dir: string): AddPlan {
  if (gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    return {
      message: `${cyan("wtr:")} checking out existing branch ${bold(branch)}`,
      addArgs: ["worktree", "add", dir, branch],
    };
  }
  if (
    git(["ls-remote", "--exit-code", "--heads", "origin", branch]).status === 0
  ) {
    return {
      message: `${cyan("wtr:")} tracking remote branch ${bold("origin/" + branch)}`,
      addArgs: [
        "worktree",
        "add",
        dir,
        "--track",
        "-b",
        branch,
        `origin/${branch}`,
      ],
    };
  }
  return {
    message: `${cyan("wtr:")} creating new branch ${bold(branch)}${base ? " off " + bold(base) : ""}`,
    addArgs: ["worktree", "add", "-b", branch, dir, ...(base ? [base] : [])],
  };
}

export function cmdAdd(args: string[]): void {
  requireRepo();
  const { branch, base } = parseAddArgs(args);
  if (!branch) fail("usage: wtr add <branch> [-b <base>]");

  const repo = repoName();
  const dir = join(WTR_ROOT, repo, folderName(branch));
  if (existsSync(dir)) fail(`${shorten(dir)} already exists`);
  mkdirSync(join(WTR_ROOT, repo), { recursive: true });

  const { addArgs, message } = resolveAddPlan(branch, base, dir);
  err(message);
  const status = gitRun(addArgs);
  if (status !== 0) process.exit(status);
  err(`${green("wtr:")} created ${shorten(dir)}`);
  emitCd(dir);
}

export async function cmdList(): Promise<void> {
  const items = listWorktrees();
  if (!items.length) {
    err(dim("(no worktrees)"));
    return;
  }
  const dirty = await dirtySet(items.map((w) => w.path));
  const width = Math.max(6, ...items.map((w) => w.branch.length));
  const rows = items.map((w) => {
    const marker = dirty.has(w.path) ? yellow(" ●") : "  ";
    return `${bold(w.branch.padEnd(width))}${marker}  ${dim(shorten(w.path))}`;
  });
  err(rows.join("\n"));
}

export async function cmdRemove(args: string[]): Promise<void> {
  requireRepo();
  const force = args.includes("--force") || args.includes("-f");
  const items = listWorktrees();
  if (!items.length) fail("no worktrees found");
  const victim = await pickItems(items, "remove> ");
  if (!victim) return;
  if (victim === CALLER_PWD) {
    fail("refusing to remove the worktree you're standing in");
  }
  if (!force) {
    const ans = promptTty(
      `${yellow("remove")} ${bold(shorten(victim))}? [y/N] `,
    );
    if (!ans || !/^y(es)?$/i.test(ans.trim())) {
      err("aborted");
      return;
    }
  }
  const status = gitRun([
    "worktree",
    "remove",
    victim,
    ...(force ? ["--force"] : []),
  ]);
  if (status !== 0) process.exit(status);
  err(`${green("wtr:")} removed ${shorten(victim)}`);
}

export function cmdHelp(): void {
  err(
    [
      `${bold("wtr")} - git worktree shortcut`,
      "",
      `${dim("Worktrees live at:")} ~/worktrees/<repo>/<folder>   ${dim("(feat/foo -> feat-foo)")}`,
      "",
      bold("Usage:"),
      `  ${cyan("wtr switch")}                     Pick a worktree and cd into it   ${dim("(alias: s, default)")}`,
      `  ${cyan("wtr add <branch>")}               Create a worktree for <branch> and cd into it`,
      `  ${cyan("wtr add <branch> -b <base>")}     Branch off <base> instead of current HEAD`,
      `  ${cyan("wtr list")}                       List worktrees for the current repo   ${dim("(alias: ls)")}`,
      `  ${cyan("wtr remove [-f]")}                Pick a worktree to remove   ${dim("(alias: rm)")}`,
      `  ${cyan("wtr help")}`,
    ].join("\n"),
  );
}
