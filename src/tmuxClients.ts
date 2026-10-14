import { execFile } from "child_process";

const TMUX_TIMEOUT_MS = 10_000;

/**
 * Pane process pid -> pid of the tmux client attached to that pane's session.
 *
 * A process in a tmux pane descends from the tmux SERVER, which is detached
 * from every terminal, so walking its parents never reaches the VS Code shell
 * whose tab shows it. The client process does run under that shell; this map
 * is the hop from one to the other. When several clients view one session,
 * the most recently active one wins.
 */
export type TmuxHops = Map<number, number>;

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
  const clientBySession = new Map<string, { pid: number; activity: number }>();
  for (const line of clients.split("\n")) {
    const m = /^(\d+) (\S+) (\d+)$/.exec(line.trim());
    if (!m) {
      continue;
    }
    const cur = clientBySession.get(m[2]);
    const activity = Number(m[3]);
    if (!cur || activity > cur.activity) {
      clientBySession.set(m[2], { pid: Number(m[1]), activity });
    }
  }
  const hops: TmuxHops = new Map();
  for (const line of panes.split("\n")) {
    const m = /^(\d+) (\S+)$/.exec(line.trim());
    const client = m && clientBySession.get(m[2]);
    if (client) {
      hops.set(Number(m[1]), client.pid);
    }
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
        if (!err) {
          resolve(stdout);
        } else if ((err as NodeJS.ErrnoException).code === "ENOENT" || /no server running|error connecting to/.test(stderr)) {
          resolve(undefined);
        } else {
          reject(new Error(`tmux ${args[0]} failed: ${stderr.trim() || err.message}`));
        }
      },
    );
  });
}
