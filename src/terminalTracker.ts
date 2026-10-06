import { execFile } from "child_process";
import { ClaudeSessionState } from "./titleFormatter";

export interface ProcInfo {
  ppid: number;
  /** Controlling terminal device path, e.g. /dev/pts/3 or /dev/ttys003. */
  tty?: string;
  /** Process start, epoch ms (second resolution). */
  startMs?: number;
}

export type ProcTable = Map<number, ProcInfo>;

const PS_TIMEOUT_MS = 10_000;

/** One `ps` snapshot of the whole process table (same flags on Linux and macOS). */
export function snapshotProcesses(): Promise<ProcTable> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,tty=,lstart="],
      // C locale: lstart is then "Tue Oct  6 09:08:23 2026", which Date.parse reads.
      // The timeout turns a hung ps (stalled /proc read) into a logged failure.
      { maxBuffer: 16 * 1024 * 1024, timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C" } },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const procs = parsePs(stdout);
        if (procs.size === 0) {
          reject(new Error("ps returned no parsable rows"));
          return;
        }
        resolve(procs);
      },
    );
  });
}

export function parsePs(out: string): ProcTable {
  const procs: ProcTable = new Map();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const startMs = Date.parse(m[4]);
    procs.set(Number(m[1]), {
      ppid: Number(m[2]),
      tty: ttyPath(m[3]),
      startMs: Number.isNaN(startMs) ? undefined : startMs,
    });
  }
  return procs;
}

function ttyPath(field: string): string | undefined {
  // Linux prints "pts/3", macOS "ttys003"; "?" / "??" mean no controlling tty.
  return /^(pts\/\d+|ttys\d+)$/.test(field) ? `/dev/${field}` : undefined;
}

/**
 * True when the live process `pid` can be the one that wrote `session`.
 * Claude Code writes `startedAt` after its process starts (measured 1-74 s
 * later), and a recycled pid belongs to a process started after the original
 * one; so a process starting more than 1 s (lstart's resolution) after
 * `startedAt` is not this session. An unknown start time fails closed.
 */
export function isSessionProcess(session: ClaudeSessionState, procs: ProcTable): boolean {
  const startMs = procs.get(session.pid)?.startMs;
  return startMs !== undefined && startMs <= session.startedAt + 1000;
}

/**
 * Bind each terminal shell to the Claude session running under it.
 *
 * A session belongs to the NEAREST ancestor that is a terminal shell, so a
 * nested shell or a second VS Code window's terminal never claims it. With
 * several sessions under one shell (claude started from inside claude), the
 * deepest one is the foreground process; ties go to the most recent update.
 */
export function bindTerminals(
  shellPids: Iterable<number>,
  sessions: Iterable<ClaudeSessionState>,
  procs: ProcTable,
): Map<number, ClaudeSessionState> {
  const shells = new Set(shellPids);
  const best = new Map<number, { session: ClaudeSessionState; depth: number }>();
  for (const session of sessions) {
    if (!isSessionProcess(session, procs)) {
      continue;
    }
    const found = nearestShell(session.pid, shells, procs);
    if (!found) {
      continue;
    }
    const current = best.get(found.shell);
    if (
      !current ||
      found.depth > current.depth ||
      (found.depth === current.depth && session.updatedAt > current.session.updatedAt)
    ) {
      best.set(found.shell, { session, depth: found.depth });
    }
  }
  const bindings = new Map<number, ClaudeSessionState>();
  for (const [shell, { session }] of best) {
    bindings.set(shell, session);
  }
  return bindings;
}

function nearestShell(
  pid: number,
  shells: Set<number>,
  procs: ProcTable,
): { shell: number; depth: number } | undefined {
  let depth = 0;
  let cur = procs.get(pid)?.ppid;
  // Bounded walk: guards against a malformed table with a ppid cycle.
  while (cur !== undefined && cur > 1 && depth < 64) {
    depth++;
    if (shells.has(cur)) {
      return { shell: cur, depth };
    }
    cur = procs.get(cur)?.ppid;
  }
  return undefined;
}
