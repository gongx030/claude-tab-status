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

/** One query of the default tmux server. No server running is an empty map. */
export async function snapshotTmuxHops(): Promise<TmuxHops> {
  const [panes, clients] = await Promise.all([
    tmux(["list-panes", "-a", "-F", "#{pane_pid} #{session_id}"]),
    tmux(["list-clients", "-F", "#{client_pid} #{session_id} #{client_activity}"]),
  ]);
  if (panes === undefined || clients === undefined) {
    return new Map();
  }
  return parseTmuxHops(panes, clients);
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
    const m = /^(\d+) (\S+)$/.exec(line.trim());
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
function tmux(args: string[]): Promise<string | undefined> {
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
