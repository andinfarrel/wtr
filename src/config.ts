import { homedir } from "node:os";
import { join } from "node:path";

export const WTR_ROOT = process.env.WTR_ROOT || join(homedir(), "worktrees");
export const CALLER_PWD = process.env.WTR_PWD || process.cwd();
