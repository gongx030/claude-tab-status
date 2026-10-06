import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeSessionState, resolveSessionName, toStatus } from "./titleFormatter";

export type Log = (msg: string) => void;

// Non-interactive session kinds CC 2.1.x writes; skipped without a log line.
const NON_INTERACTIVE_KINDS = new Set(["bg", "daemon", "daemon-worker"]);

/** "Not there": absent, or a `~/.claude-*` entry that is a file (e.g. a backup archive). */
function isAbsent(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Every Claude Code session directory: `<config>/sessions` for `~/.claude` and
 * each `~/.claude-*` config dir (one per launcher backend), plus
 * `$CLAUDE_CONFIG_DIR`. Directories that are the same on disk (backends often
 * symlink `sessions/` to `~/.claude/sessions`) are listed once.
 */
export async function sessionDirs(log: Log, home: string = os.homedir()): Promise<string[]> {
  const configs = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) {
    configs.add(process.env.CLAUDE_CONFIG_DIR);
  }
  try {
    for (const entry of await fsp.readdir(home)) {
      if (entry === ".claude" || entry.startsWith(".claude-")) {
        configs.add(path.join(home, entry));
      }
    }
  } catch (e) {
    log(`cannot list ${home}: ${(e as Error).message}`);
  }
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const config of configs) {
    const dir = path.join(config, "sessions");
    try {
      const st = await fsp.stat(dir);
      const key = `${st.dev}:${st.ino}`;
      if (st.isDirectory() && !seen.has(key)) {
        seen.add(key);
        dirs.push(dir);
      }
    } catch (e) {
      if (!isAbsent(e)) {
        log(`cannot stat ${dir}: ${(e as Error).message}`);
      }
    }
  }
  if (dirs.length === 0) {
    log(`no Claude Code session directories found under ${home}`);
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
  startedAt?: unknown;
  updatedAt?: unknown;
}

/** Thrown for a file that exists but cannot be read as JSON (e.g. caught mid-write). */
class UnreadableSession extends Error {}

/**
 * Validate one `<pid>.json`. Returns undefined for anything that is not an
 * interactive session: a missing binding is preferable to a wrong one. An
 * unrecognised status is kept as `status: undefined` so the caller can hold
 * the last title. Throws `UnreadableSession` for invalid JSON.
 */
export function parseSessionFile(text: string, file: string, log: Log): ClaudeSessionState | undefined {
  let raw: RawSession;
  try {
    raw = JSON.parse(text) as RawSession;
  } catch {
    throw new UnreadableSession(`unparsable session file ${file}`);
  }
  if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string" || typeof raw.startedAt !== "number") {
    log(`ignoring session file without numeric pid/startedAt or string sessionId: ${file}`);
    return undefined;
  }
  if (raw.kind !== undefined && raw.kind !== "interactive") {
    if (!(typeof raw.kind === "string" && NON_INTERACTIVE_KINDS.has(raw.kind))) {
      log(`skipping ${file}: unrecognised kind ${JSON.stringify(raw.kind)}`);
    }
    return undefined;
  }
  const status = toStatus(raw.status);
  if (!status) {
    log(`${file}: unrecognised status ${JSON.stringify(raw.status)}; holding the last title`);
  }
  return {
    sessionId: raw.sessionId,
    pid: raw.pid,
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    name: resolveSessionName({ name: raw.name, sessionId: raw.sessionId }),
    status,
    startedAt: raw.startedAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

export interface SessionScan {
  /** Interactive sessions keyed by Claude pid (liveness is checked against `ps`, not here). */
  sessions: Map<number, ClaudeSessionState>;
  /** Pids whose file exists but could not be read this time; their titles are held, not reset. */
  unreadable: Set<number>;
}

export async function readSessions(dirs: string[], log: Log): Promise<SessionScan> {
  const scan: SessionScan = { sessions: new Map(), unreadable: new Set() };
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch (e) {
      log(`cannot list ${dir}: ${(e as Error).message}`);
      continue;
    }
    for (const entry of entries) {
      const m = /^(\d+)\.json$/.exec(entry);
      if (!m) {
        continue;
      }
      const file = path.join(dir, entry);
      try {
        const session = parseSessionFile(await fsp.readFile(file, "utf8"), file, log);
        if (session) {
          scan.sessions.set(session.pid, session);
        }
      } catch (e) {
        if (isAbsent(e)) {
          continue; // removed between readdir and read: the session ended
        }
        log(`cannot read ${file}: ${(e as Error).message}`);
        scan.unreadable.add(Number(m[1]));
      }
    }
  }
  return scan;
}
