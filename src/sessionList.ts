import { ClaudeSessionState } from "./titleFormatter";
import { isSessionProcess, ProcTable } from "./terminalTracker";
import { TmuxSnapshot } from "./tmuxClients";

/** One row of the session sidebar: a tmux session running a Claude Code session. */
export interface SessionRow {
  tmuxId: string;
  tmuxName: string;
  /** Recorded launcher, e.g. `claude` or `claude_build`. */
  launcher: string;
  session: ClaudeSessionState;
  /** Shell pids of the VS Code terminals attached to this tmux session; more than one is a duplicate. */
  terminals: number[];
}

/** Bound on every parent walk: guards a malformed table with a ppid cycle. */
const MAX_DEPTH = 64;

/**
 * Rows for every tmux session that has a backend record and a live Claude
 * Code session in one of its panes. A session without a record was not
 * created by a launcher that writes one, and is left out.
 *
 * With several Claude sessions in one tmux session, the most recently
 * updated one names the row.
 */
export function buildRows(
  sessions: Iterable<ClaudeSessionState>,
  procs: ProcTable,
  tmux: TmuxSnapshot,
  launchers: Map<string, string>,
  shellPids: Set<number>,
): SessionRow[] {
  const byTmux = new Map<string, ClaudeSessionState>();
  for (const session of sessions) {
    if (!isSessionProcess(session, procs)) {
      continue;
    }
    const pane = selfOrAncestor(session.pid, procs, (pid) => tmux.panes.has(pid));
    const tmuxId = pane === undefined ? undefined : tmux.panes.get(pane);
    if (tmuxId === undefined || !launchers.has(tmuxId)) {
      continue;
    }
    const current = byTmux.get(tmuxId);
    if (!current || session.updatedAt > current.updatedAt) {
      byTmux.set(tmuxId, session);
    }
  }
  const rows: SessionRow[] = [];
  for (const [tmuxId, session] of byTmux) {
    const terminals: number[] = [];
    for (const client of tmux.clients) {
      if (client.sessionId !== tmuxId) {
        continue;
      }
      const shell = selfOrAncestor(client.pid, procs, (pid) => shellPids.has(pid));
      if (shell !== undefined && !terminals.includes(shell)) {
        terminals.push(shell);
      }
    }
    rows.push({
      tmuxId,
      tmuxName: tmux.sessions.get(tmuxId) ?? tmuxId,
      launcher: launchers.get(tmuxId)!,
      session,
      terminals,
    });
  }
  return rows.sort((a, b) => a.tmuxName.localeCompare(b.tmuxName));
}

/** What is remembered about a listed session so it can be resumed after its tmux session ends. */
export interface KnownSession {
  tmuxName: string;
  launcher: string;
  /** Claude Code session name and id; the id resumes a session that has no named wrapper. */
  name: string;
  sessionId: string;
  cwd?: string;
  /** Epoch ms the session was last seen running. */
  lastSeen: number;
}

/** `known` updated with every running row, keyed by tmux session name. */
export function rememberRows(known: KnownSession[], rows: SessionRow[], now: number): KnownSession[] {
  const byName = new Map(known.map((k) => [k.tmuxName, k]));
  for (const r of rows) {
    byName.set(r.tmuxName, {
      tmuxName: r.tmuxName,
      launcher: r.launcher,
      name: r.session.name,
      sessionId: r.session.sessionId,
      cwd: r.session.cwd,
      lastSeen: now,
    });
  }
  return [...byName.values()].sort((a, b) => a.tmuxName.localeCompare(b.tmuxName));
}

/**
 * Remembered sessions whose tmux session no longer exists. One whose tmux
 * session is alive but shows no Claude row (starting, or held on an exit
 * message) is neither running nor stopped, and is left out.
 */
export function stoppedSessions(known: KnownSession[], tmux: TmuxSnapshot): KnownSession[] {
  const alive = new Set(tmux.sessions.values());
  return known.filter((k) => !alive.has(k.tmuxName));
}

/** The pane (`%7`) whose root process is `pid` or one of its ancestors, from `list-panes -F "#{pane_pid} #{pane_id}"`. */
export function paneOf(pid: number, panes: string, procs: ProcTable): string | undefined {
  const byPid = new Map<number, string>();
  for (const line of panes.split("\n")) {
    const m = /^(\d+) (%\d+)$/.exec(line.trim());
    if (m) {
      byPid.set(Number(m[1]), m[2]);
    }
  }
  const root = selfOrAncestor(pid, procs, (p) => byPid.has(p));
  return root === undefined ? undefined : byPid.get(root);
}

/**
 * First of `pid` and its ancestors matching `hit`. `pid` itself counts: a
 * terminal this extension creates runs the tmux client as its shell process.
 */
function selfOrAncestor(pid: number, procs: ProcTable, hit: (pid: number) => boolean): number | undefined {
  let cur: number | undefined = pid;
  for (let depth = 0; depth < MAX_DEPTH && cur !== undefined && cur > 1; depth++) {
    if (hit(cur)) {
      return cur;
    }
    cur = procs.get(cur)?.ppid;
  }
  return undefined;
}

/** `claude_build` -> `build`; the plain launcher stays `claude`. */
export function backendLabel(launcher: string): string {
  return launcher.startsWith("claude_") ? launcher.slice("claude_".length) : launcher;
}

/** POSIX single-quoted shell word. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `bash -ic` command that resumes `k` on `launcher`.
 *
 * A session with a named wrapper in ~/.bashrc (`autodev2`) resumes through it,
 * taking the backend word `_cc_session` reads (`autodev2 build`), so it comes
 * back in its own named tmux session. Without one, the launcher function
 * resumes the exact conversation id from the session's directory. A failure
 * (e.g. a refused backend) holds the tab open so its message can be read.
 */
export function resumeCommand(k: KnownSession, launcher: string): string {
  const word = launcher === "claude" ? "" : ` ${q(backendLabel(launcher))}`;
  const direct = `${k.cwd ? `cd ${q(k.cwd)} && ` : ""}${q(launcher)} -r ${q(k.sessionId)}`;
  return (
    `if declare -F ${q(k.tmuxName)} >/dev/null; then ${q(k.tmuxName)}${word}; else ${direct}; fi` +
    ` || { rc=$?; echo; read -rp "exited $rc; Enter to close " _; }`
  );
}
