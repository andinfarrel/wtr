import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wtr-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    WTR_ROOT: worktrees,
    WTR_PWD: repo,
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git(
    "-c",
    "user.name=Wtr Test",
    "-c",
    "user.email=wtr@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "Initial commit",
  );
  const add = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(projectDir, "src/wtr.ts"), "add", ...args],
      {
        cwd: repo,
        env,
        encoding: "utf8",
      },
    );
  return { repo, worktrees, env, git, add };
}

test("add defaults to the branch-derived folder", (t) => {
  const { add, worktrees } = fixture(t);
  const result = add("feat/default");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(worktrees, "repo", "feat-default"));
});

for (const shell of ["bash", "zsh"]) {
  test(`add with a custom folder changes the ${shell} working directory`, (t) => {
    const { repo, worktrees, env, git } = fixture(t);
    const result = spawnSync(
      shell,
      [
        "-f",
        "-c",
        'source "$1"; wtr add feat/branch-name "custom folder-name" && pwd',
        shell,
        join(projectDir, "wtr.sh"),
      ],
      { cwd: repo, env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const dir = join(worktrees, "repo", "custom folder-name");
    assert.equal(result.stdout.trim(), dir);
    assert.equal(
      git("-C", dir, "branch", "--show-current"),
      "feat/branch-name",
    );
    assert.equal(
      existsSync(join(worktrees, "repo", "feat-branch-name")),
      false,
    );
  });
}

for (const args of [
  ["feat/from-base", "custom-folder", "-b", "base"],
  ["--from", "base", "feat/from-base", "custom-folder"],
  ["feat/from-base", "-b", "base", "custom-folder"],
]) {
  test(`add accepts a custom folder with base arguments: ${args.join(" ")}`, (t) => {
    const { add, worktrees, git } = fixture(t);
    git("branch", "base");
    git(
      "-c",
      "user.name=Wtr Test",
      "-c",
      "user.email=wtr@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Advance main",
    );
    const result = add(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      join(worktrees, "repo", "custom-folder"),
    );
    assert.equal(git("rev-parse", "feat/from-base"), git("rev-parse", "base"));
  });
}

test("add checks out an existing branch in the custom folder", (t) => {
  const { add, worktrees, git } = fixture(t);
  git("branch", "feat/existing");
  const result = add("feat/existing", "existing-folder");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    join(worktrees, "repo", "existing-folder"),
  );
});

test("add refuses an existing custom folder", (t) => {
  const { add, worktrees, git } = fixture(t);
  mkdirSync(join(worktrees, "repo", "taken"), { recursive: true });
  const result = add("feat/collision", "taken");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(git("branch", "--list"), /feat\/collision/);
});

for (const folder of [
  "",
  ".",
  "..",
  "../outside",
  "/absolute",
  "nested/folder",
]) {
  test(`add rejects invalid custom folder ${JSON.stringify(folder)}`, (t) => {
    const { add, worktrees } = fixture(t);
    const result = add("feat/invalid", folder);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /folder must be a single directory name/);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(worktrees), false);
  });
}

for (const args of [
  [],
  ["feat/invalid", "folder", "extra"],
  ["feat/invalid", "folder", "-b"],
]) {
  test(`add rejects incomplete or extra arguments: ${args.join(" ")}`, (t) => {
    const { add, worktrees } = fixture(t);
    const result = add(...args);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /usage: wtr add <branch> \[folder\] \[-b <base>\]/,
    );
    assert.equal(result.stdout, "");
    assert.equal(existsSync(worktrees), false);
  });
}
