import { ClaudeSessionState, formatTerminalTitle } from "./titleFormatter";
import { Log } from "./claudeSessions";

export interface Binding {
  shellPid: number;
  tty: string;
  session: ClaudeSessionState;
}

interface Rendered {
  tty: string;
  title: string;
  session: ClaudeSessionState;
}

export type TitleWriter = (tty: string, title: string) => void;

/**
 * Last title written to each terminal shell. Writes only on change, so an idle
 * fleet costs no tty traffic; a failed write is not recorded and therefore
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
   *   title is cleared only if its shell still owns the same tty: a closed
   *   terminal's pts number can be reused by another terminal.
   */
  update(bindings: Binding[], shellTtys: Map<number, string>): void {
    const live = new Set<number>();
    for (const b of bindings) {
      live.add(b.shellPid);
      const title = formatTerminalTitle(b.session);
      const prev = this.rendered.get(b.shellPid);
      if (prev && prev.title === title && prev.tty === b.tty) {
        continue;
      }
      this.describe(b, prev);
      try {
        this.write(b.tty, title);
        this.rendered.set(b.shellPid, { tty: b.tty, title, session: b.session });
        this.log(`title updated: shell ${b.shellPid} ${b.tty} -> "${title}"`);
      } catch (e) {
        this.log(`title write failed for ${b.tty}: ${(e as Error).message}`);
      }
    }
    for (const [shellPid, prev] of this.rendered) {
      if (live.has(shellPid)) {
        continue;
      }
      this.rendered.delete(shellPid);
      this.log(`binding lost: shell ${shellPid} (session ${prev.session.sessionId})`);
      if (shellTtys.get(shellPid) !== prev.tty) {
        continue;
      }
      try {
        this.write(prev.tty, ""); // empty title: VS Code falls back to its own label
      } catch (e) {
        this.log(`title reset failed for ${prev.tty}: ${(e as Error).message}`);
      }
    }
  }

  /** Forget everything without touching any terminal (extension disabled). */
  clear(): void {
    this.rendered.clear();
  }

  private describe(b: Binding, prev: Rendered | undefined): void {
    const s = b.session;
    if (!prev || prev.session.sessionId !== s.sessionId) {
      this.log(`Claude pid ${s.pid} matched to shell ${b.shellPid}; session ${s.sessionId} "${s.name}"`);
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
