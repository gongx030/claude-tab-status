import * as fs from "fs";
import * as vscode from "vscode";
import { readSessions, sessionDirs } from "./claudeSessions";
import { Binding, StatusStore } from "./statusStore";
import { buildRows, SessionRow } from "./sessionList";
import { SessionTreeProvider } from "./sessionTree";
import { bindTerminals, ProcTable, snapshotProcesses } from "./terminalTracker";
import { BackendRecords, EMPTY_TMUX, snapshotTmux, TmuxSnapshot } from "./tmuxClients";
import { writeTitle } from "./ttyTitle";

const WATCH_DEBOUNCE_MS = 150;
const DEFAULT_INTERVAL_MS = 3000;

let shutdown: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("Claude Tab Status");
  context.subscriptions.push(channel);

  // The reconcile loop re-derives the same state every tick; print a line only
  // when it was not also logged during the previous reconcile.
  let lastLines = new Set<string>();
  let thisLines = new Set<string>();
  const log = (msg: string) => {
    thisLines.add(msg);
    if (!lastLines.has(msg)) {
      channel.appendLine(`[${new Date().toISOString()}] ${msg}`);
    }
  };

  const store = new StatusStore(writeTitle, log);
  const shellPids = new Map<vscode.Terminal, number>();
  const watchers = new Map<string, fs.FSWatcher>();
  let dirs: string[] = [];
  let procs: ProcTable | undefined;
  let tmux: TmuxSnapshot = EMPTY_TMUX;
  const backends = new BackendRecords();
  const tree = new SessionTreeProvider();
  /** Terminals this extension opened per tmux session id, until their shell pid shows up as a client (pruned in reconcileOnce). */
  const opened = new Map<string, vscode.Terminal>();
  let snapshotPids = ""; // session pids present when `procs` was taken
  let running = false;
  let disposed = false;
  let rerun: boolean | undefined; // undefined: none pending; else whether ps is needed
  let debounce: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;

  const config = () => vscode.workspace.getConfiguration("claudeTabStatus");

  async function reconcile(full: boolean): Promise<void> {
    if (disposed) {
      return;
    }
    if (running) {
      rerun = (rerun ?? false) || full;
      return;
    }
    running = true;
    try {
      await reconcileOnce(full);
    } catch (e) {
      log(`reconcile failed: ${(e as Error).message}`);
    } finally {
      running = false;
      lastLines = thisLines;
      thisLines = new Set();
      if (rerun !== undefined) {
        const again = rerun;
        rerun = undefined;
        void reconcile(again);
      }
    }
  }

  /** @param full re-discover session dirs, re-run ps and re-assert titles (timer, terminal opened). */
  async function reconcileOnce(full: boolean): Promise<void> {
    const titles = config().get<boolean>("enabled", true);
    if (!titles) {
      // First, so a failing ps or tmux below cannot keep the titles.
      store.update([], shellTtys(procs)); // resets every title this extension set
    }
    if (full || dirs.length === 0) {
      dirs = await sessionDirs(log);
      watchDirs(dirs);
    }
    const { sessions, unreadable } = await readSessions(dirs, log);
    // A new or reused session pid needs a fresh process table: a cached one
    // could hold the previous owner of that pid.
    const pids = [...sessions.keys()].sort().join(",");
    if (full || !procs || pids !== snapshotPids) {
      // A failing tmux query must not stop the tabs outside tmux updating, and
      // keeps the last known hops so tmux tabs hold their titles, not reset.
      [procs, tmux] = await Promise.all([
        snapshotProcesses(),
        snapshotTmux().catch((e: Error) => {
          log(`${e.message}; keeping the previous tmux bindings`);
          return tmux;
        }),
      ]);
      snapshotPids = pids;
    }
    const launchers = await backends.refresh(tmux.sessions.keys(), log);
    if (disposed) {
      return;
    }
    // A pending tab whose client has shown up is now found through `tmux.clients`;
    // keeping it would point at whatever session that client switched to later.
    const clientPids = new Set(tmux.clients.map((c) => c.pid));
    for (const [id, t] of opened) {
      const pid = shellPids.get(t);
      if (pid !== undefined && clientPids.has(pid)) {
        opened.delete(id);
      }
    }
    tree.update(buildRows(sessions.values(), procs, tmux, launchers, new Set(shellPids.values())));
    if (!titles) {
      return;
    }
    const bindings: Binding[] = [];
    for (const [shellPid, session] of bindTerminals(shellPids.values(), sessions.values(), procs, tmux.hops)) {
      const tty = procs.get(shellPid)?.tty;
      if (tty) {
        bindings.push({ shellPid, tty, session });
      } else {
        log(`Claude pid ${session.pid} is under shell ${shellPid}, which has no recognised tty`);
      }
    }
    // Timer ticks re-assert unchanged titles, winning the tab back within one
    // interval if Claude Code (title not disabled) overwrote it.
    store.update(bindings, shellTtys(procs), unreadable, full);
  }

  function shellTtys(table: ProcTable | undefined): Map<number, string> {
    const ttys = new Map<number, string>();
    for (const pid of shellPids.values()) {
      const tty = table?.get(pid)?.tty;
      if (tty) {
        ttys.set(pid, tty);
      }
    }
    return ttys;
  }

  function watchDirs(current: string[]): void {
    for (const dir of current) {
      if (watchers.has(dir)) {
        continue;
      }
      try {
        const w = fs.watch(dir, () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => void reconcile(false), WATCH_DEBOUNCE_MS);
        });
        w.on("error", (e) => {
          log(`watch on ${dir} failed: ${e.message}; re-arming on the next timer tick`);
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
        log(`watching ${dir}`);
      } catch (e) {
        log(`cannot watch ${dir}: ${(e as Error).message}; relying on the reconcile timer`);
      }
    }
  }

  async function track(terminal: vscode.Terminal): Promise<void> {
    try {
      const pid = await terminal.processId;
      if (pid === undefined) {
        log(`terminal "${terminal.name}" has no process id; ignored`);
      } else if (!shellPids.has(terminal) && vscode.window.terminals.includes(terminal)) {
        shellPids.set(terminal, pid);
        log(`terminal discovered: "${terminal.name}" shell pid ${pid}`);
      }
    } catch (e) {
      log(`cannot get process id of terminal "${terminal.name}": ${(e as Error).message}`);
    }
  }

  function restartTimer(): void {
    clearInterval(timer);
    const raw = config().get<unknown>("refreshIntervalMs", DEFAULT_INTERVAL_MS);
    let ms = DEFAULT_INTERVAL_MS;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      ms = Math.max(1000, raw);
    } else {
      log(`ignoring invalid claudeTabStatus.refreshIntervalMs ${JSON.stringify(raw)}; using ${DEFAULT_INTERVAL_MS}`);
    }
    timer = setInterval(() => void reconcile(true), ms);
  }

  shutdown = () => {
    disposed = true;
    clearInterval(timer);
    clearTimeout(debounce);
    for (const w of watchers.values()) {
      w.close();
    }
    // Leave no frozen "name ●" behind (disable, uninstall, window close).
    for (const tty of store.renderedTtys().values()) {
      try {
        writeTitle(tty, "");
      } catch {
        // terminal already gone
      }
    }
  };

  /** VS Code terminals attached to `row`'s tmux session, in `row.terminals` order. */
  function terminalsOf(row: SessionRow): vscode.Terminal[] {
    const byPid = new Map([...shellPids].map(([t, pid]) => [pid, t]));
    return row.terminals.map((pid) => byPid.get(pid)).filter((t): t is vscode.Terminal => t !== undefined);
  }

  /**
   * Show the tab already attached to the row's tmux session, or open one.
   * A tab opened here counts as attached before its client shows up in the
   * next tmux snapshot, so a double click does not open two.
   */
  function openSession(clicked?: SessionRow): void {
    if (!clicked) {
      return;
    }
    const row = tree.row(clicked.tmuxId) ?? clicked;
    const pending = opened.get(row.tmuxId);
    const existing = terminalsOf(row)[0] ?? (pending && vscode.window.terminals.includes(pending) ? pending : undefined);
    if (existing) {
      existing.show();
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: row.tmuxName,
      shellPath: "tmux",
      // By id: exact, and unaffected by a later rename of the session.
      shellArgs: ["attach-session", "-t", row.tmuxId],
      // tmux refuses to attach from inside another tmux client.
      env: { TMUX: null, TMUX_PANE: null },
      // Beside the other Claude Code tabs, which live in the editor area.
      location: vscode.TerminalLocation.Editor,
    });
    opened.set(row.tmuxId, terminal);
    terminal.show();
    log(`opened a terminal attached to tmux session ${row.tmuxId} (${row.tmuxName})`);
  }

  /** Keep the active (else the first) tab attached to the session; close the others. */
  function closeDuplicates(clicked?: SessionRow): void {
    const row = clicked && (tree.row(clicked.tmuxId) ?? clicked);
    if (!row) {
      return;
    }
    const tabs = terminalsOf(row);
    const keep = tabs.find((t) => t === vscode.window.activeTerminal) ?? tabs[0];
    for (const t of tabs) {
      if (t !== keep) {
        t.dispose();
      }
    }
  }

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("claudeTabStatus.sessions", tree),
    vscode.commands.registerCommand("claudeTabStatus.openSession", openSession),
    vscode.commands.registerCommand("claudeTabStatus.closeDuplicateTabs", closeDuplicates),
    vscode.commands.registerCommand("claudeTabStatus.refreshSessions", () => reconcile(true)),
    vscode.window.onDidOpenTerminal(async (t) => {
      await track(t);
      void reconcile(true);
    }),
    vscode.window.onDidCloseTerminal((t) => {
      shellPids.delete(t);
      for (const [id, o] of opened) {
        if (o === t) {
          opened.delete(id);
        }
      }
      void reconcile(false);
    }),
    vscode.window.onDidChangeActiveTerminal(() => void reconcile(false)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeTabStatus")) {
        restartTimer();
        void reconcile(true);
      }
    }),
  );

  restartTimer();
  void Promise.all(vscode.window.terminals.map(track)).then(() => reconcile(true));
}

export function deactivate(): void {
  shutdown?.();
  shutdown = undefined;
}
