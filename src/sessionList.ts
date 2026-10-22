import { ClaudeSessionState } from "./titleFormatter";
import { isSessionProcess, ProcTable } from "./terminalTracker";
import { TmuxSnapshot } from "./tmuxClients";

/** One row of the session sidebar: a tmux session running a Claude Code session. */
export interface SessionRow {
  tmuxId: string;
  tmuxName: string;
  /**
   * Launcher, e.g. `claude` or `claude_build`: the tmux session's
   * `CC_BACKEND` record, else the one inferred from the Claude process's
   * config dir; undefined when neither is known.
   */
  launcher: string | undefined;
  /** True when `launcher` is not a `CC_BACKEND` record (inferred, or unknown). */
  unrecorded: boolean;
  session: ClaudeSessionState;
  /** Shell pids of the VS Code terminals attached to this tmux session; more than one is a duplicate. */
  terminals: number[];
}

/** Why a Claude process in a tmux pane has no row; see `buildRows`. */
export type Omission = (pid: number, tmuxId: string, reason: string) => void;

/** Bound on every parent walk: guards a malformed table with a ppid cycle. */
const MAX_DEPTH = 64;

/**
 * Rows for every tmux session with a live Claude Code session in one of its
 * panes, recorded backend or not: `inferred` (Claude pid -> launcher) names
 * the launcher of a tmux session without a `CC_BACKEND` record.
 *
 * With several Claude sessions in one tmux session, the most recently
 * updated one names the row. A session file whose pid runs in a pane but
 * fails the liveness check is reported to `omit`.
 */
export function buildRows(
  sessions: Iterable<ClaudeSessionState>,
  procs: ProcTable,
  tmux: TmuxSnapshot,
  launchers: Map<string, string>,
  shellPids: Set<number>,
  inferred: Map<number, string> = new Map(),
  omit: Omission = () => undefined,
): SessionRow[] {
  const byTmux = new Map<string, ClaudeSessionState>();
  for (const session of sessions) {
    const tmuxId = tmuxSessionOf(session.pid, procs, tmux);
    if (tmuxId === undefined) {
      continue;
    }
    if (!isSessionProcess(session, procs)) {
      const startMs = procs.get(session.pid)?.startMs;
      omit(
        session.pid,
        tmuxId,
        startMs === undefined
          ? "ps gave no start time for it"
          : `its process started at ${new Date(startMs).toISOString()}, after its session file's startedAt ` +
              `${new Date(session.startedAt).toISOString()} (a recycled pid, or clock skew)`,
      );
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
    const recorded = launchers.get(tmuxId);
    rows.push({
      tmuxId,
      tmuxName: tmux.sessions.get(tmuxId) ?? tmuxId,
      launcher: recorded ?? inferred.get(session.pid),
      unrecorded: recorded === undefined,
      session,
      terminals,
    });
  }
  return rows.sort((a, b) => a.tmuxName.localeCompare(b.tmuxName));
}

/**
 * The tmux session whose pane runs `pid`: the pane whose root is `pid` or an
 * ancestor, else the pane on `pid`'s controlling tty (a process reparented
 * away from its pane's root still has that pane as its terminal). A process
 * absent from `procs` has ended and is in none.
 */
function tmuxSessionOf(pid: number, procs: ProcTable, tmux: TmuxSnapshot): string | undefined {
  const proc = procs.get(pid);
  if (!proc) {
    return undefined;
  }
  const pane = selfOrAncestor(pid, procs, (p) => tmux.panes.has(p));
  if (pane !== undefined) {
    return tmux.panes.get(pane);
  }
  return proc.tty === undefined ? undefined : tmux.paneTtys.get(proc.tty);
}

/** What is remembered about a listed session so it can be resumed after its tmux session ends. */
export interface KnownSession {
  tmuxName: string;
  /** Last known launcher (recorded or inferred); undefined when it never was known, and Resume asks. */
  launcher?: string;
  /** Claude Code session name and id; Resume continues the name's newest conversation in `cwd`, not this id. */
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
    const k = key({ host, tmuxName: r.tmuxName });
    byName.set(k, {
      host,
      tmuxName: r.tmuxName,
      launcher: r.launcher ?? byName.get(k)?.launcher,
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
 * message) is neither running nor stopped, and is left out. So is one whose
 * conversation is running under another tmux name (same id, or same name in
 * the same folder): Resume would only be refused as already open.
 */
export function stoppedSessions(known: KnownSession[], tmux: TmuxSnapshot, host: string, rows: SessionRow[]): KnownSession[] {
  const alive = new Set(tmux.sessions.values());
  const running = (k: KnownSession) =>
    rows.some((r) => r.session.sessionId === k.sessionId || (k.cwd !== undefined && r.session.name === k.name && r.session.cwd === k.cwd));
  return known.filter((k) => k.host === host && !alive.has(k.tmuxName) && !running(k));
}

/**
 * The pane (`%7`) whose root process is `pid` or one of its ancestors, else
 * the one on `pid`'s controlling tty, from
 * `list-panes -F "#{pane_pid} #{pane_id} #{pane_tty}"` (the tty is optional).
 */
export function paneOf(pid: number, panes: string, procs: ProcTable): string | undefined {
  const byPid = new Map<number, string>();
  const byTty = new Map<string, string>();
  for (const line of panes.split("\n")) {
    const m = /^(\d+) (%\d+)(?: (\S+))?$/.exec(line.trim());
    if (m) {
      byPid.set(Number(m[1]), m[2]);
      if (m[3]) {
        byTty.set(m[3], m[2]);
      }
    }
  }
  const root = selfOrAncestor(pid, procs, (p) => byPid.has(p));
  if (root !== undefined) {
    return byPid.get(root);
  }
  const tty = procs.get(pid)?.tty;
  return tty === undefined ? undefined : byTty.get(tty);
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

/** `claude_build` -> `build`; the plain launcher stays `claude`; an unknown one is `unrecorded`. */
export function backendLabel(launcher: string | undefined): string {
  if (launcher === undefined) {
    return "unrecorded";
  }
  return launcher.startsWith("claude_") ? launcher.slice("claude_".length) : launcher;
}

/**
 * The text beside a Stopped row: its backend; its tmux session name when that
 * is not the label (tmux spells `.` and `:` as `_`), since entries are kept per
 * tmux name and two that ran one Claude session name otherwise look the same;
 * and `folder missing` when `missing`, so a dead row is visible before Resume.
 */
export function stoppedDescription(known: KnownSession, missing: boolean): string {
  const parts = [backendLabel(known.launcher)];
  if (known.tmuxName !== known.name.replace(/[.:]/g, "_")) {
    parts.push(known.tmuxName);
  }
  if (missing) {
    parts.push("folder missing");
  }
  return parts.join(" · ");
}
