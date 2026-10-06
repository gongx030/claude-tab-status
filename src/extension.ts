import * as fs from "fs";
import * as vscode from "vscode";
import { readSessions, sessionDirs } from "./claudeSessions";
import { Binding, StatusStore } from "./statusStore";
import { bindTerminals, ProcTable, snapshotProcesses } from "./terminalTracker";
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
    if (!config().get<boolean>("enabled", true)) {
      store.update([], shellTtys(procs)); // resets every title this extension set
      return;
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
      procs = await snapshotProcesses();
      snapshotPids = pids;
    }
    if (disposed) {
      return;
    }
    const bindings: Binding[] = [];
    for (const [shellPid, session] of bindTerminals(shellPids.values(), sessions.values(), procs)) {
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

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(async (t) => {
      await track(t);
      void reconcile(true);
    }),
    vscode.window.onDidCloseTerminal((t) => {
      shellPids.delete(t);
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
