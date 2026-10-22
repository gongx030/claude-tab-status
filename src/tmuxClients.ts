import { execFile } from "child_process";

// Short: a hung server would otherwise hold up every tab's reconcile, tmux or not.
const TMUX_TIMEOUT_MS = 2_000;

/**
 * Pane process pid -> pids of the tmux clients attached to that pane's session.
 *
 * A process in a tmux pane descends from the tmux SERVER, which is detached
 * from every terminal, so walking its parents never reaches the VS Code shell
 * whose tab shows it. The client process does run under that shell; this map
 * is the hop from one to the other. Clients are ordered most recently active
 * first; a client outside this window (ssh, another window) is skipped by the
 * walk rather than hiding the one that is here.
 */
export type TmuxHops = Map<number, number[]>;

export interface TmuxSnapshot {
  hops: TmuxHops;
  /** Pane root pid -> tmux session id (`$3`). */
  panes: Map<number, string>;
  /**
   * Pane tty (`/dev/pts/9`) -> tmux session id. Finds the pane of a process
   * that is no longer a descendant of its pane's root (reparented when an
   * intermediate parent exited) by its controlling terminal.
   */
  paneTtys: Map<string, string>;
  /** Attached clients: pid and the session id each shows. */
  clients: { pid: number; sessionId: string }[];
  /** Session id -> session name. */
  sessions: Map<string, string>;
}

export const EMPTY_TMUX: TmuxSnapshot = { hops: new Map(), panes: new Map(), paneTtys: new Map(), clients: [], sessions: new Map() };

/** A `list-panes` line: `pane_pid session_id [pane_tty]`. */
const PANE_LINE = /^(\d+) (\S+)(?: (\S+))?$/;

/** One query of the default tmux server. No server running is an empty snapshot. */
export async function snapshotTmux(): Promise<TmuxSnapshot> {
  const [panes, clients, sessions] = await Promise.all([
    tmux(["list-panes", "-a", "-F", "#{pane_pid} #{session_id} #{pane_tty}"]),
    tmux(["list-clients", "-F", "#{client_pid} #{session_id} #{client_activity}"]),
    // Tab-separated: a session name may contain spaces.
    tmux(["list-sessions", "-F", "#{session_id}\t#{session_name}"]),
  ]);
  if (panes === undefined || clients === undefined || sessions === undefined) {
    return EMPTY_TMUX;
  }
  return parseTmuxSnapshot(panes, clients, sessions);
}

export function parseTmuxSnapshot(panes: string, clients: string, sessions: string): TmuxSnapshot {
  const snap: TmuxSnapshot = {
    hops: parseTmuxHops(panes, clients),
    panes: new Map(),
    paneTtys: new Map(),
    clients: [],
    sessions: new Map(),
  };
  for (const line of panes.split("\n")) {
    const m = PANE_LINE.exec(line.trim());
    if (m) {
      snap.panes.set(Number(m[1]), m[2]);
      if (m[3]) {
        snap.paneTtys.set(m[3], m[2]);
      }
    }
  }
  for (const line of clients.split("\n")) {
    const m = /^(\d+) (\S+) \d+$/.exec(line.trim());
    if (m) {
      snap.clients.push({ pid: Number(m[1]), sessionId: m[2] });
    }
  }
  for (const line of sessions.split("\n")) {
    const m = /^(\$\d+)\t(.+)$/.exec(line);
    if (m) {
      snap.sessions.set(m[1], m[2]);
    }
  }
  return snap;
}

/**
 * tmux session-environment variable naming the launcher that created the
 * session (`claude`, `claude_build`, ...). Written by unified-agent-sdk's
 * launcher (`TMUX_BACKEND_VAR`) and by the `_cc_session` shell wrapper.
 */
export const BACKEND_VAR = "CC_BACKEND";

/** How long an absent record is trusted before asking again (a record can be added later). */
const ABSENT_RECHECK_MS = 60_000;

/**
 * Recorded launcher per tmux session id. A present record is set at session
 * creation and kept for the session's life, so it is read once; an absent one
 * is re-read at most every `ABSENT_RECHECK_MS`, which keeps the per-session
 * `show-environment` calls off the 3 s reconcile path.
 */
export class BackendRecords {
  private cache = new Map<string, { launcher?: string; checkedAt: number }>();

  async refresh(sessionIds: Iterable<string>, log: (msg: string) => void, now = Date.now()): Promise<Map<string, string>> {
    const ids = [...sessionIds];
    const live = new Set(ids);
    for (const id of this.cache.keys()) {
      if (!live.has(id)) {
        this.cache.delete(id);
      }
    }
    await Promise.all(
      ids.map(async (id) => {
        const hit = this.cache.get(id);
        if (hit && (hit.launcher !== undefined || now - hit.checkedAt < ABSENT_RECHECK_MS)) {
          return;
        }
        try {
          this.cache.set(id, { launcher: await readBackendRecord(id), checkedAt: now });
        } catch (e) {
          // Not cached, so the next reconcile asks again.
          log(`cannot read ${BACKEND_VAR} of tmux session ${id}: ${(e as Error).message}`);
        }
      }),
    );
    const out = new Map<string, string>();
    for (const [id, { launcher }] of this.cache) {
      if (launcher !== undefined) {
        out.set(id, launcher);
      }
    }
    return out;
  }
}

/**
 * The recorded launcher, or undefined when the session has none. Other
 * failures (timeout, session gone mid-query) throw.
 */
async function readBackendRecord(sessionId: string): Promise<string | undefined> {
  try {
    const out = await tmux(["show-environment", "-t", sessionId, BACKEND_VAR]);
    return out === undefined ? undefined : parseBackendRecord(out);
  } catch (e) {
    // tmux 3.3a: "unknown variable: CC_BACKEND", exit 1.
    if (/unknown variable/.test((e as Error).message)) {
      return undefined;
    }
    throw e;
  }
}

/** `CC_BACKEND=claude_build` -> `claude_build`; a removed (`-CC_BACKEND`) or empty record -> undefined. */
export function parseBackendRecord(out: string): string | undefined {
  const m = new RegExp(`^${BACKEND_VAR}=(\\S+)$`).exec(out.trim());
  return m ? m[1] : undefined;
}

export function parseTmuxHops(panes: string, clients: string): TmuxHops {
  const bySession = new Map<string, { pid: number; activity: number }[]>();
  const lines = clients.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = /^(\d+) (\S+) (\d+)$/.exec(line);
    if (m) {
      const list = bySession.get(m[2]) ?? [];
      list.push({ pid: Number(m[1]), activity: Number(m[3]) });
      bySession.set(m[2], list);
    }
  }
  if (lines.length > 0 && bySession.size === 0) {
    throw new Error(`tmux list-clients output unrecognised: ${JSON.stringify(lines[0])}`);
  }
  const hops: TmuxHops = new Map();
  for (const line of panes.split("\n")) {
    const m = PANE_LINE.exec(line.trim());
    const list = m && bySession.get(m[2]);
    if (list) {
      // A pane in grouped sessions is listed once per session: merge them.
      const pids = [...(hops.get(Number(m[1])) ?? []), ...list.map((c) => c.pid)];
      hops.set(Number(m[1]), pids);
    }
  }
  const activity = new Map([...bySession.values()].flat().map((c) => [c.pid, c.activity]));
  for (const pids of hops.values()) {
    pids.sort((a, b) => (activity.get(b) ?? 0) - (activity.get(a) ?? 0));
  }
  return hops;
}

/** stdout, or undefined when tmux is absent or has no server. Other failures throw. */
export function tmux(args: string[]): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      "tmux",
      args,
      { maxBuffer: 1024 * 1024, timeout: TMUX_TIMEOUT_MS, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        // Only these mean "no server"; "error connecting to" with any other
        // errno (Permission denied, ...) is a real failure (tmux 3.3a wording).
        const noServer =
          /^no server running on /m.test(stderr) ||
          /^error connecting to .* \(No such file or directory\)$/m.test(stderr);
        if (!err) {
          resolve(stdout);
        } else if ((err as NodeJS.ErrnoException).code === "ENOENT" || noServer) {
          resolve(undefined);
        } else if (err.killed) {
          reject(new Error(`tmux ${args[0]} timed out after ${TMUX_TIMEOUT_MS} ms`));
        } else {
          reject(new Error(`tmux ${args[0]} failed (exit ${err.code}): ${stderr.trim() || err.message}`));
        }
      },
    );
  });
}
