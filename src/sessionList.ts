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
  /** Claude Code session name and id; Resume continues exactly this conversation id. */
  name: string;
  sessionId: string;
  cwd?: string;
  /**
   * Host whose tmux server ran it. globalState is shared by every Remote-SSH
   * host the client connects to, and "absent from this host's tmux" says
   * nothing about a session on another host.
   */
  host: string;
  /** Epoch ms the session was last seen running. */
  lastSeen: number;
}

/** `known` updated with every running row on `host`, keyed by host and tmux session name. */
export function rememberRows(known: KnownSession[], rows: SessionRow[], host: string, now: number): KnownSession[] {
  const key = (k: { host: string; tmuxName: string }) => `${k.host}\0${k.tmuxName}`;
  const byName = new Map(known.map((k) => [key(k), k]));
  for (const r of rows) {
    byName.set(key({ host, tmuxName: r.tmuxName }), {
      host,
      tmuxName: r.tmuxName,
      launcher: r.launcher,
      name: r.session.name,
      sessionId: r.session.sessionId,
      cwd: r.session.cwd,
      lastSeen: now,
    });
  }
  return [...byName.values()].sort((a, b) => a.tmuxName.localeCompare(b.tmuxName) || a.host.localeCompare(b.host));
}

/** `known` with the session `tmuxName` on `host` set to resume in `cwd`; undefined if it is not remembered. */
export function withFolder(known: KnownSession[], host: string, tmuxName: string, cwd: string): KnownSession[] | undefined {
  const hit = (k: KnownSession) => k.host === host && k.tmuxName === tmuxName;
  return known.some(hit) ? known.map((k) => (hit(k) ? { ...k, cwd } : k)) : undefined;
}

/**
 * Remembered sessions whose tmux session no longer exists. One whose tmux
 * session is alive but shows no Claude row (starting, or held on an exit
 * message) is neither running nor stopped, and is left out.
 */
export function stoppedSessions(known: KnownSession[], tmux: TmuxSnapshot, host: string): KnownSession[] {
  const alive = new Set(tmux.sessions.values());
  return known.filter((k) => k.host === host && !alive.has(k.tmuxName));
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
