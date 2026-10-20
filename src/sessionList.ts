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
