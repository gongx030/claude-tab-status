export type ClaudeStatus = "working" | "waiting" | "idle";

export interface ClaudeSessionState {
  sessionId: string;
  pid: number;
  cwd?: string;
  name: string;
  /** undefined: the session file carries a status this version does not know; hold the last title. */
  status: ClaudeStatus | undefined;
  /** Epoch ms at which Claude Code wrote the session; used to reject recycled pids. */
  startedAt: number;
  updatedAt: number;
}

const SYMBOL: Record<ClaudeStatus, string> = {
  working: "●",
  waiting: "🟠", // colour emoji: the only coloured mark, so tabs needing attention stand out
  idle: "○",
};

/**
 * Claude Code's own session-file status (enum in CC 2.1.x: busy, shell, idle,
 * waiting) mapped to the three displayed states. `shell` is CC's "turn ended
 * but a shell command it started is still running" (e.g. a long pytest moved
 * to the background); the session is still at work on it, so it shows as
 * working. Unknown values return undefined rather than a guess.
 */
export function toStatus(raw: unknown): ClaudeStatus | undefined {
  switch (raw) {
    case "busy":
    case "shell":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
}

/**
 * Session name, highest priority first: CC already resolves `/rename` >
 * `--name` > derived name into the `name` field, so only the short-id fallback
 * is ours.
 */
export function resolveSessionName(meta: { name?: unknown; sessionId: string }): string {
  const name = typeof meta.name === "string" ? stripControl(meta.name).trim() : "";
  return name || stripControl(meta.sessionId).slice(0, 8);
}

export function formatTerminalTitle(session: ClaudeSessionState & { status: ClaudeStatus }): string {
  return `${session.name} ${SYMBOL[session.status]}`;
}

/**
 * Titles are written raw into an OSC sequence on the terminal's tty, so they
 * must never carry ESC/BEL or other C0/C1 controls. `writeTitle` applies this
 * too, as the last line of defence.
 */
export function stripControl(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}
