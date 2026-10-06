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

/**
 * Last title written to each terminal shell. Writes on change, and on a
 * re-assert pass rewrites unchanged titles too: another program in the
 * terminal (Claude Code without CLAUDE_CODE_DISABLE_TERMINAL_TITLE) may have
 * replaced ours. A failed write or reset is not recorded and is therefore
 * retried on the next reconcile.
 */
export class StatusStore {
  private rendered = new Map<number, Rendered>();

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
      if (unchanged && !reassert) {
        continue;
      }
      try {
        this.write(b.tty, title);
      } catch (e) {
        this.log(`title write failed for ${b.tty}: ${(e as Error).message}`);
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
      if (ownsTty) {
        try {
          this.write(prev.tty, ""); // empty title: VS Code falls back to its own label
        } catch (e) {
          this.log(`title reset failed for ${prev.tty}: ${(e as Error).message}`);
          continue; // keep the entry so the reset is retried
        }
      }
      this.rendered.delete(shellPid);
      this.log(`binding lost: shell ${shellPid} (session ${prev.session.sessionId})`);
    }
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
