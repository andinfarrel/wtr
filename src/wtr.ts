#!/usr/bin/env node

import { red } from "./ansi.ts";
import { cmdAdd, cmdHelp, cmdList, cmdRemove, cmdSwitch } from "./commands.ts";
import { err, fail } from "./io.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "switch";
  const rest = argv.slice(1);
  switch (cmd) {
    case "switch":
    case "s":
      await cmdSwitch();
      break;
    case "add":
    case "a":
      cmdAdd(rest);
      break;
    case "list":
    case "ls":
    case "l":
      await cmdList();
      break;
    case "remove":
    case "rm":
      await cmdRemove(rest);
      break;
    case "help":
    case "-h":
    case "--help":
      cmdHelp();
      break;
    default:
      fail(`unknown command '${cmd}' (try: wtr help)`);
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    err(`${red("wtr:")} ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
