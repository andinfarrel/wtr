import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { scanStatuses, type StatusScan, type WorktreeStatus } from "./git.ts";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(projectDir, "src/wtr.ts");
const tempRoot = existsSync(join(tmpdir(), "opencode"))
  ? join(tmpdir(), "opencode")
  : tmpdir();

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for subprocess output");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type Event = { event: string; path: string; pid: number; locks?: string };
type FakeStatus = { stdout?: string; code?: number; blocked?: boolean };

function fixture(
  t: TestContext,
  config: Record<string, FakeStatus> = { one: {}, two: {} },
) {
  const root = mkdtempSync(join(tempRoot, "wtr-performance-"));
  const bin = join(root, "bin");
  const log = join(root, "events.jsonl");
  mkdirSync(bin);
  const items = Object.keys(config).map((branch) => {
    const path = join(root, branch);
    mkdirSync(path);
    return { path, branch, detached: false };
  });
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
const args = process.argv.slice(2);
const items = JSON.parse(process.env.WTR_TEST_ITEMS);
if (args[0] === "worktree") {
  process.stdout.write(items.map(w => "worktree " + w.path + "\\nbranch refs/heads/" + w.branch + "\\n\\n").join(""));
} else if (args[0] === "rev-parse") {
  process.stdout.write(process.env.WTR_TEST_ROOT + "\\n");
} else if (args[0] === "-C" && args[2] === "status") {
  const path = args[1];
  const config = JSON.parse(process.env.WTR_TEST_CONFIG)[basename(path)] || {};
  const log = event => appendFileSync(process.env.WTR_TEST_LOG, JSON.stringify({event, path, pid: process.pid, locks: process.env.GIT_OPTIONAL_LOCKS}) + "\\n");
  process.on("SIGTERM", () => { log("stop"); process.exit(143); });
  log("start");
  const finish = () => { log("finish"); process.stdout.write(config.stdout || "", () => process.exit(config.code || 0)); };
  if (config.blocked) {
    const timer = setInterval(() => {
      if (existsSync(join(process.env.WTR_TEST_ROOT, basename(path) + ".release"))) {
        clearInterval(timer);
        finish();
      }
    }, 10);
  } else finish();
} else process.exit(1);
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "fzf"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const originalEnv = process.env;
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NO_COLOR: "1",
    WTR_TEST_ROOT: root,
    WTR_TEST_LOG: log,
    WTR_TEST_ITEMS: JSON.stringify(items),
    WTR_TEST_CONFIG: JSON.stringify(config),
  };
  process.env = env;
  const scans: StatusScan[] = [];
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const scan of scans) scan.cancel();
    await Promise.all(scans.map((scan) => scan.done));
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null)
              return resolve();
            child.once("close", () => resolve());
            child.kill("SIGTERM");
          }),
      ),
    );
    process.env = originalEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const launch = (command: string, args: string[]) => {
    const child = spawn(command, args, { cwd: projectDir, env });
    children.push(child);
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk: Buffer) => {
      output.stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output.stderr += chunk.toString();
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { child, output, done };
  };
  return {
    root,
    bin,
    items,
    events: (): Event[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Event)
        : [],
    release: (name: string) => writeFileSync(join(root, `${name}.release`), ""),
    scan: (
      onStatus: (path: string, status: WorktreeStatus) => void,
      options?: { concurrency?: number; timeout?: number },
    ) => {
      const scan = scanStatuses(
        items.map((w) => w.path),
        onStatus,
        options,
      );
      scans.push(scan);
      return scan;
    },
    launch,
    picker: (rows = 24) =>
      launch(process.execPath, [
        "--input-type=module",
        "-e",
        `
      import { pickItems } from ${JSON.stringify(join(projectDir, "src/picker.ts"))};
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      process.stdin.setRawMode = () => process.stdin;
      Object.defineProperty(process.stderr, "columns", { value: 100 });
      Object.defineProperty(process.stderr, "rows", { value: ${rows} });
      const target = await pickItems(JSON.parse(process.env.WTR_TEST_ITEMS), "switch> ");
      if (target) process.stdout.write(target + "\\n");
      process.exit(0);
    `,
      ]),
  };
}

test("plain listing and aliases never start status checks", async (t) => {
  const f = fixture(t, { one: { blocked: true }, two: { blocked: true } });
  for (const alias of ["list", "ls", "l"]) {
    const run = f.launch(process.execPath, [cli, alias]);
    assert.equal(await run.done, 0, run.output.stderr);
    assert.equal(run.output.stdout, "");
    assert.match(run.output.stderr, /one/);
    assert.match(run.output.stderr, /two/);
    assert.doesNotMatch(run.output.stderr, /[●·?]/);
  }
  assert.deepEqual(f.events(), []);
});

test("explicit status listing waits for checks and distinguishes failed checks", async (t) => {
  const f = fixture(t, {
    clean: {},
    dirty: { stdout: "?? new-file\n", blocked: true },
    broken: { code: 1 },
  });
  const run = f.launch(process.execPath, [cli, "list", "--status"]);
  await waitFor(() =>
    f
      .events()
      .some(
        (event) => event.event === "start" && event.path.endsWith("/dirty"),
      ),
  );
  assert.equal(run.output.stderr, "");
  f.release("dirty");
  assert.equal(await run.done, 0, run.output.stderr);
  assert.equal(run.output.stdout, "");
  assert.match(run.output.stderr, /dirty\s+●/);
  assert.match(run.output.stderr, /broken\s+\?/);
  assert.match(run.output.stderr, /clean\s+\//);
  assert.ok(f.events().every((event) => event.locks === "0"));
});

for (const shell of ["bash", "zsh"]) {
  test(`${shell} returns success for list and help, and preserves failures`, async (t) => {
    const f = fixture(t);
    for (const [args, expected] of [
      [["list"], 0],
      [["list", "--status"], 0],
      [["help"], 0],
      [["list", "--typo"], 1],
      [["unknown"], 1],
    ] as const) {
      const run = f.launch(shell, [
        "-f",
        "-c",
        'source "$1"; shift; wtr "$@"',
        shell,
        join(projectDir, "wtr.sh"),
        ...args,
      ]);
      assert.equal(await run.done, expected, run.output.stderr);
      assert.equal(run.output.stdout, "");
    }
  });
}

test("status workers respect their limit and cancel running and queued checks", async (t) => {
  const f = fixture(
    t,
    Object.fromEntries(
      ["one", "two", "three", "four", "five", "six"].map((name) => [
        name,
        { blocked: true },
      ]),
    ),
  );
  const updates: string[] = [];
  const scan = f.scan((path) => updates.push(path));
  await waitFor(
    () => f.events().filter((event) => event.event === "start").length === 4,
  );
  scan.cancel();
  await scan.done;
  assert.equal(f.events().filter((event) => event.event === "start").length, 4);
  assert.equal(f.events().filter((event) => event.event === "stop").length, 4);
  assert.deepEqual(updates, []);
  for (const event of f.events().filter((event) => event.event === "start")) {
    assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
  }
});

test("queued status checks can prioritize visible paths and publish individual results", async (t) => {
  const f = fixture(t, {
    one: { blocked: true },
    two: { blocked: true, stdout: " M tracked-file\n" },
    three: { blocked: true, code: 1 },
  });
  const updates: [string, WorktreeStatus][] = [];
  const scan = f.scan((path, status) => updates.push([path, status]), {
    concurrency: 1,
  });
  await waitFor(() => f.events().some((event) => event.event === "start"));
  scan.prioritize([f.items[2]!.path]);
  f.release("one");
  await waitFor(() =>
    f
      .events()
      .some(
        (event) => event.event === "start" && event.path.endsWith("/three"),
      ),
  );
  assert.deepEqual(updates, [[f.items[0]!.path, "clean"]]);
  assert.ok(!f.events().some((event) => event.path.endsWith("/two")));
  f.release("three");
  await waitFor(() =>
    f
      .events()
      .some((event) => event.event === "start" && event.path.endsWith("/two")),
  );
  f.release("two");
  await scan.done;
  assert.deepEqual(updates, [
    [f.items[0]!.path, "clean"],
    [f.items[2]!.path, "unknown"],
    [f.items[1]!.path, "dirty"],
  ]);
});

test("status timeouts and spawn failures are unknown, not clean", async (t) => {
  const f = fixture(t, { one: { blocked: true } });
  const updates: WorktreeStatus[] = [];
  await f.scan((_, status) => updates.push(status), { timeout: 100 }).done;
  assert.deepEqual(updates, ["unknown"]);
  process.env.PATH = join(f.root, "missing-bin");
  await f.scan((_, status) => updates.push(status)).done;
  assert.deepEqual(updates, ["unknown", "unknown"]);
});

test("empty and immediately cancelled scans finish without spawning Git", async (t) => {
  const f = fixture(t);
  await scanStatuses([], () => assert.fail("unexpected update")).done;
  const scan = f.scan(() => assert.fail("unexpected update"));
  scan.cancel();
  await scan.done;
  assert.deepEqual(f.events(), []);
});

test("picker renders and accepts a selection while all status checks are blocked", async (t) => {
  const f = fixture(
    t,
    Object.fromEntries(
      ["one", "two", "three", "four", "five", "six"].map((name) => [
        name,
        { blocked: true },
      ]),
    ),
  );
  const run = f.picker();
  await waitFor(() => run.output.stderr.includes("switch>"));
  assert.match(run.output.stderr, / ·/);
  await waitFor(
    () => f.events().filter((event) => event.event === "start").length === 4,
  );
  assert.ok(f.events().every((event) => event.event === "start"));
  run.child.stdin.write("six");
  await waitFor(() => run.output.stderr.includes("six▌"));
  run.child.stdin.write("\r");
  assert.equal(await run.done, 0, run.output.stderr);
  assert.equal(run.output.stdout.trim(), f.items[5]!.path);
  assert.equal(f.events().filter((event) => event.event === "start").length, 4);
  assert.equal(f.events().filter((event) => event.event === "stop").length, 4);
});

test("background status redraws preserve the query and selected row", async (t) => {
  const f = fixture(t, {
    one: { blocked: true },
    two: { blocked: true, stdout: "?? file\n" },
    three: { blocked: true, code: 1 },
  });
  const run = f.picker();
  await waitFor(
    () => f.events().filter((event) => event.event === "start").length === 3,
  );
  run.child.stdin.write("t\x1b[B");
  await waitFor(() => run.output.stderr.includes("t▌  2/2"));
  const before = run.output.stderr.length;
  f.release("two");
  f.release("three");
  await waitFor(
    () =>
      run.output.stderr.slice(before).includes(" ●") &&
      run.output.stderr.slice(before).includes(" ?"),
  );
  assert.match(run.output.stderr.slice(before), /t▌  2\/2/);
  run.child.stdin.write("\r");
  assert.equal(await run.done, 0, run.output.stderr);
  assert.equal(run.output.stdout.trim(), f.items[2]!.path);
});

test("background status redraws preserve the scrolled window", async (t) => {
  const f = fixture(
    t,
    Object.fromEntries(
      ["one", "two", "three", "four", "five", "six"].map((name) => [
        name,
        { blocked: true, stdout: "?? file\n" },
      ]),
    ),
  );
  const run = f.picker(5);
  await waitFor(
    () => f.events().filter((event) => event.event === "start").length === 4,
  );
  run.child.stdin.write("\x1b[B".repeat(4));
  await waitFor(() => run.output.stderr.includes("5/6"));
  f.release("one");
  await waitFor(() =>
    f
      .events()
      .some((event) => event.event === "start" && event.path.endsWith("/five")),
  );
  const before = run.output.stderr.length;
  f.release("five");
  await waitFor(() => run.output.stderr.slice(before).includes(" ●"));
  const redraw = run.output.stderr.slice(before);
  assert.match(redraw, /5\/6/);
  assert.match(redraw, /four/);
  assert.match(redraw, /five/);
  assert.doesNotMatch(redraw, /one|two|three|six/);
  run.child.stdin.write("\r");
  assert.equal(await run.done, 0, run.output.stderr);
  assert.equal(run.output.stdout.trim(), f.items[4]!.path);
});

test("fzf selection does not start background status scans", async (t) => {
  const f = fixture(t, { one: { blocked: true }, two: { blocked: true } });
  writeFileSync(
    join(f.bin, "fzf"),
    `#!${process.execPath}
if (process.argv.includes("--version")) process.exit(0);
let input = "";
process.stdin.on("data", chunk => { input += chunk.toString(); });
process.stdin.on("end", () => process.stdout.write(input.split("\\n")[1] + "\\n"));
`,
    { mode: 0o755 },
  );
  const run = f.launch(process.execPath, [cli, "switch"]);
  assert.equal(await run.done, 0, run.output.stderr);
  assert.equal(run.output.stdout.trim(), f.items[1]!.path);
  assert.deepEqual(f.events(), []);
});

for (const cancel of ["escape", "ctrl-c", "SIGINT", "SIGTERM"]) {
  test(`picker ${cancel} cancels status children and emits no cd target`, async (t) => {
    const f = fixture(t, { one: { blocked: true } });
    const run = f.picker();
    await waitFor(() => f.events().some((event) => event.event === "start"));
    if (cancel === "SIGTERM" || cancel === "SIGINT") run.child.kill(cancel);
    else run.child.stdin.write(cancel === "escape" ? "\x1b" : "\x03");
    assert.equal(
      await run.done,
      cancel === "ctrl-c" || cancel === "SIGINT"
        ? 130
        : cancel === "SIGTERM"
          ? 143
          : 0,
      run.output.stderr,
    );
    assert.equal(run.output.stdout, "");
    assert.equal(
      f.events().filter((event) => event.event === "stop").length,
      1,
    );
    assert.ok(run.output.stderr.endsWith("\x1b[?25h"));
  });
}

test("real Git status detects staged, unstaged, and untracked files", async (t) => {
  const root = mkdtempSync(join(tempRoot, "wtr-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths: string[] = [];
  for (const name of ["clean", "staged", "unstaged", "untracked"]) {
    const path = join(root, name);
    mkdirSync(path);
    paths.push(path);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: path,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "--initial-branch=main");
    writeFileSync(join(path, "tracked"), "original\n");
    git("add", "tracked");
    git(
      "-c",
      "user.name=Wtr Test",
      "-c",
      "user.email=wtr@example.com",
      "commit",
      "-m",
      "Initial commit",
    );
    if (name === "staged" || name === "unstaged")
      appendFileSync(join(path, "tracked"), "changed\n");
    if (name === "staged") git("add", "tracked");
    if (name === "untracked") writeFileSync(join(path, "new-file"), "new\n");
  }
  const statuses = new Map<string, WorktreeStatus>();
  await scanStatuses(paths, (path, status) => statuses.set(path, status)).done;
  assert.equal(statuses.get(paths[0]!), "clean");
  for (const path of paths.slice(1)) assert.equal(statuses.get(path), "dirty");
});
