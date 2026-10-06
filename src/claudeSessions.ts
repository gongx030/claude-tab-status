import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeSessionState, resolveSessionName, toStatus } from "./titleFormatter";

export type Log = (msg: string) => void;

/**
 * Every Claude Code session directory: `<config>/sessions` for `~/.claude` and
 * each `~/.claude-*` config dir (one per launcher backend), plus
 * `$CLAUDE_CONFIG_DIR`. Directories that are the same on disk (backends often
 * symlink `sessions/` to `~/.claude/sessions`) are listed once.
 */
export function sessionDirs(home: string = os.homedir()): string[] {
  const configs = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) {
    configs.add(process.env.CLAUDE_CONFIG_DIR);
  }
  try {
    for (const entry of fs.readdirSync(home)) {
      if (entry === ".claude" || entry.startsWith(".claude-")) {
        configs.add(path.join(home, entry));
      }
    }
  } catch {
    // home unreadable: nothing to watch
  }
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const config of configs) {
    const dir = path.join(config, "sessions");
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      continue;
    }
    const key = `${st.dev}:${st.ino}`;
    if (!seen.has(key)) {
      seen.add(key);
      dirs.push(dir);
    }
  }
  return dirs;
}

interface RawSession {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  kind?: unknown;
  name?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  procStart?: unknown;
}

export interface ParsedSession {
  state: ClaudeSessionState;
  procStart?: string;
}

/**
 * Validate one `<pid>.json`. Returns undefined for anything that is not an
 * interactive session with a known status: a missing binding is preferable to
 * a wrong one.
 */
export function parseSessionFile(text: string, fileName: string, log: Log): ParsedSession | undefined {
  let raw: RawSession;
  try {
    raw = JSON.parse(text) as RawSession;
  } catch {
    log(`ignoring unparsable session file ${fileName}`);
    return undefined;
  }
  if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string") {
    log(`ignoring session file without pid/sessionId: ${fileName}`);
    return undefined;
  }
  if (raw.kind !== undefined && raw.kind !== "interactive") {
    return undefined;
  }
  const status = toStatus(raw.status);
  if (!status) {
    log(`session ${raw.sessionId}: unknown status ${JSON.stringify(raw.status)}`);
    return undefined;
  }
  return {
    state: {
      sessionId: raw.sessionId,
      pid: raw.pid,
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      name: resolveSessionName({ name: raw.name, sessionId: raw.sessionId }),
      status,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    },
    procStart: typeof raw.procStart === "string" ? raw.procStart : undefined,
  };
}

/**
 * Linux only: CC's `procStart` is field 22 (starttime) of /proc/<pid>/stat.
 * A mismatch means the pid was recycled by an unrelated process. Elsewhere,
 * or when /proc is unreadable, returns true and liveness is judged by the
 * process-table snapshot alone.
 */
export function procStartMatches(pid: number, procStart: string | undefined): boolean {
  if (!procStart || process.platform !== "linux") {
    return true;
  }
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false; // process gone
  }
  // comm (field 2) may contain spaces and parens; fields resume after the last ')'.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19] === procStart; // field 22 overall = index 19 after comm
}

/** All live interactive sessions in `dirs`, keyed by Claude pid. */
export function readSessions(dirs: string[], log: Log): Map<number, ClaudeSessionState> {
  const sessions = new Map<number, ClaudeSessionState>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^\d+\.json$/.test(entry)) {
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, entry), "utf8");
      } catch {
        continue; // removed between readdir and read
      }
      const parsed = parseSessionFile(text, entry, log);
      if (parsed && procStartMatches(parsed.state.pid, parsed.procStart)) {
        sessions.set(parsed.state.pid, parsed.state);
      }
    }
  }
  return sessions;
}
