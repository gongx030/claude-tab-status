import { ClaudeSessionState, ClaudeStatus, formatTerminalTitle } from "./titleFormatter";
import { Log } from "./claudeSessions";

export interface Binding {
  shellPid: number;
  tty: string;
  session: ClaudeSessionState;
}

interface Rendered {
  tty: string;
  title: string;
  session: ClaudeSessionState & { status: ClaudeStatus };
}

export type TitleWriter = (tty: string, title: string) => void;

/** Re-assert passes to skip a tty after a failed write (10 x 3 s by default). */
const REASSERT_BACKOFF = 10;

/**
 * Last title written to each terminal shell. Writes on change, and on a
 * re-assert pass rewrites unchanged titles too: another program in the
 * terminal (Claude Code without CLAUDE_CODE_DISABLE_TERMINAL_TITLE) may have
 * replaced ours. A failed write or reset is not recorded and is therefore
 * retried: a changed title on the next reconcile, an unchanged one on a later
 * re-assert pass after a back-off (see `failing`).
 */
export class StatusStore {
  private rendered = new Map<number, Rendered>();
  /**
   * ttys whose last write failed. A failure usually means the terminal's
   * output is backed up (EAGAIN or a short write), so re-assert skips the tty
   * for `REASSERT_BACKOFF` passes instead of writing into a full buffer every
   * tick. Each distinct failure is logged once, not every tick.
   */
  private failing = new Map<string, { msg: string; skip: number }>();

  constructor(
    private readonly write: TitleWriter,
    private readonly log: Log,
  ) {}

  /**
   * @param shellTtys tty of every terminal shell still alive. A lost binding's
   *   title is reset only if its shell still owns the same tty: a closed
   *   terminal's pts number can be reused by another terminal.
   * @param held Claude pids whose session file exists but was unreadable this
   *   time (e.g. caught mid-write); their titles are kept rather than reset.
   * @param reassert rewrite titles even when unchanged.
   */
  update(
    bindings: Binding[],
    shellTtys: Map<number, string>,
    held: Set<number> = new Set(),
    reassert = false,
  ): void {
    const live = new Set<number>();
    for (const b of bindings) {
      const prev = this.rendered.get(b.shellPid);
      const { status } = b.session;
      if (status === undefined) {
        // Unrecognised status: hold whatever is shown.
        if (prev) {
          live.add(b.shellPid);
        }
        continue;
      }
      live.add(b.shellPid);
      const session = { ...b.session, status };
      const title = formatTerminalTitle(session);
      const unchanged = prev !== undefined && prev.title === title && prev.tty === b.tty;
      if (unchanged && (!reassert || this.backingOff(b.tty))) {
        continue;
      }
      if (!this.tryWrite(b.tty, title, "title write")) {
        continue;
      }
      this.rendered.set(b.shellPid, { tty: b.tty, title, session });
      this.describe(b.shellPid, session, prev);
    }
    for (const [shellPid, prev] of this.rendered) {
      const ownsTty = shellTtys.get(shellPid) === prev.tty;
      if (live.has(shellPid) || (ownsTty && held.has(prev.session.pid))) {
        continue;
      }
      // Empty title: VS Code falls back to its own label. On failure keep the
      // entry so the reset is retried.
      if (ownsTty && !this.tryWrite(prev.tty, "", "title reset")) {
        continue;
      }
      this.rendered.delete(shellPid);
      this.failing.delete(prev.tty);
      this.log(`binding lost: shell ${shellPid} (session ${prev.session.sessionId})`);
    }
  }

  private tryWrite(tty: string, title: string, what: string): boolean {
    try {
      this.write(tty, title);
    } catch (e) {
      const msg = `${what} failed for ${tty}: ${(e as Error).message}`;
      if (this.failing.get(tty)?.msg !== msg) {
        this.log(msg);
      }
      this.failing.set(tty, { msg, skip: REASSERT_BACKOFF });
      return false;
    }
    if (this.failing.delete(tty)) {
      this.log(`writes to ${tty} succeed again`);
    }
    return true;
  }

  /** True while a failing tty's re-assert back-off lasts; counts down one pass per call. */
  private backingOff(tty: string): boolean {
    const f = this.failing.get(tty);
    if (!f || f.skip === 0) {
      return false;
    }
    f.skip--;
    return true;
  }

  /** Every tty a title was written to, for the final reset on shutdown. */
  renderedTtys(): Map<number, string> {
    return new Map([...this.rendered].map(([shell, r]) => [shell, r.tty]));
  }

  private describe(shellPid: number, s: Rendered["session"], prev: Rendered | undefined): void {
    const title = formatTerminalTitle(s);
    if (!prev || prev.session.sessionId !== s.sessionId) {
      this.log(`Claude pid ${s.pid} matched to shell ${shellPid}; session ${s.sessionId}; title "${title}"`);
      return;
    }
    if (prev.session.name !== s.name) {
      this.log(`session renamed: "${prev.session.name}" -> "${s.name}"`);
    }
    if (prev.session.status !== s.status) {
      this.log(`status transition: "${s.name}" ${prev.session.status} -> ${s.status}`);
    }
  }
}
