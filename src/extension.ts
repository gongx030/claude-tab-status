import * as fs from "fs";
import * as vscode from "vscode";
import { readSessions, sessionDirs } from "./claudeSessions";
import { Binding, StatusStore } from "./statusStore";
import { bindTerminals, ProcTable, snapshotProcesses } from "./terminalTracker";
import { writeTitle } from "./ttyTitle";

const WATCH_DEBOUNCE_MS = 150;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("Claude Tab Status");
  context.subscriptions.push(channel);

  // The reconcile loop re-derives the same state every tick; log each distinct
  // line once in a row instead of every few seconds.
  let lastLines: string[] = [];
  let thisLines: string[] = [];
  const log = (msg: string) => {
    thisLines.push(msg);
    if (!lastLines.includes(msg)) {
      channel.appendLine(`[${new Date().toISOString()}] ${msg}`);
    }
  };

  const store = new StatusStore(writeTitle, log);
  const shellPids = new Map<vscode.Terminal, number>();
  const watchers = new Map<string, fs.FSWatcher>();
  let procs: ProcTable | undefined;
  let running = false;
  let rerun: boolean | undefined; // undefined: none pending; else whether ps is needed
  let debounce: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;

  const enabled = () => vscode.workspace.getConfiguration("claudeTabStatus").get<boolean>("enabled", true);

  async function reconcile(refreshPs: boolean): Promise<void> {
    if (running) {
      rerun = (rerun ?? false) || refreshPs;
      return;
    }
    running = true;
    try {
      await reconcileOnce(refreshPs);
    } catch (e) {
      log(`reconcile failed: ${(e as Error).message}`);
    } finally {
      running = false;
      lastLines = thisLines;
      thisLines = [];
      if (rerun !== undefined) {
        const again = rerun;
        rerun = undefined;
        void reconcile(again);
      }
    }
  }

  async function reconcileOnce(refreshPs: boolean): Promise<void> {
    if (!enabled()) {
      store.update([], shellTtys(procs)); // resets every title this extension set
      return;
    }
    const dirs = sessionDirs();
    watchDirs(dirs);
    const sessions = readSessions(dirs, log);
    const missing = [...sessions.keys()].some((pid) => !procs?.has(pid));
    if (refreshPs || !procs || missing) {
      procs = await snapshotProcesses();
    }
    const bindings: Binding[] = [];
    for (const [shellPid, session] of bindTerminals(shellPids.values(), sessions, procs)) {
      const tty = procs.get(shellPid)?.tty;
      if (tty) {
        bindings.push({ shellPid, tty, session });
      }
    }
    store.update(bindings, shellTtys(procs));
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

  function watchDirs(dirs: string[]): void {
    for (const dir of dirs) {
      if (watchers.has(dir)) {
        continue;
      }
      try {
        const w = fs.watch(dir, () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => void reconcile(false), WATCH_DEBOUNCE_MS);
        });
        w.on("error", (e) => {
          log(`watch on ${dir} failed: ${e.message}; relying on the reconcile timer`);
          w.close();
        });
        watchers.set(dir, w);
        log(`watching ${dir}`);
      } catch (e) {
        log(`cannot watch ${dir}: ${(e as Error).message}; relying on the reconcile timer`);
      }
    }
  }

  async function track(terminal: vscode.Terminal): Promise<void> {
    const pid = await terminal.processId;
    if (pid !== undefined && !shellPids.has(terminal) && vscode.window.terminals.includes(terminal)) {
      shellPids.set(terminal, pid);
      log(`terminal discovered: "${terminal.name}" shell pid ${pid}`);
    }
  }

  function restartTimer(): void {
    clearInterval(timer);
    const ms = Math.max(1000, vscode.workspace.getConfiguration("claudeTabStatus").get<number>("refreshIntervalMs", 3000));
    timer = setInterval(() => void reconcile(true), ms);
  }

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
    {
      dispose: () => {
        clearInterval(timer);
        clearTimeout(debounce);
        for (const w of watchers.values()) {
          w.close();
        }
      },
    },
  );

  restartTimer();
  void Promise.all(vscode.window.terminals.map(track)).then(() => reconcile(true));
}

export function deactivate(): void {}
