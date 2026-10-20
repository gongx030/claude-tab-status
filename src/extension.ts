import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { readSessions, sessionDirs } from "./claudeSessions";
import { Binding, StatusStore } from "./statusStore";
import {
  backendLabel,
  buildRows,
  KnownSession,
  paneOf,
  rememberRows,
  resumeCommand,
  SessionRow,
  stoppedSessions,
} from "./sessionList";
import { SessionNode, SessionTreeProvider } from "./sessionTree";
import { bindTerminals, ProcTable, snapshotProcesses } from "./terminalTracker";
import { BackendRecords, EMPTY_TMUX, snapshotTmux, tmux as runTmux, TmuxSnapshot } from "./tmuxClients";
import { writeTitle } from "./ttyTitle";

const WATCH_DEBOUNCE_MS = 150;
const DEFAULT_INTERVAL_MS = 3000;
/** globalState key of the remembered sessions behind the Stopped group. */
const KNOWN_KEY = "claudeTabStatus.knownSessions";
/** A remembered session's `lastSeen` is persisted at most this often; structural changes immediately. */
const KNOWN_SAVE_MS = 5 * 60_000;
/** How long Stop waits for Claude Code to exit before offering a forced kill. */
const STOP_WAIT_MS = 15_000;
/** Remembered sessions are per host: see KnownSession.host. */
const HOST = os.hostname();

function loadKnown(raw: unknown): KnownSession[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (k): k is KnownSession =>
      typeof k?.tmuxName === "string" &&
      typeof k.launcher === "string" &&
      typeof k.name === "string" &&
      typeof k.sessionId === "string" &&
      typeof k.host === "string" &&
      typeof k.lastSeen === "number",
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  let known = loadKnown(context.globalState.get(KNOWN_KEY));
  const shapeOf = (ks: KnownSession[]) => JSON.stringify(ks.map(({ lastSeen: _, ...k }) => k));
  let knownSaved = { shape: shapeOf(known), at: Date.now() };

  /**
   * Persist `known` on any change but `lastSeen`, and otherwise every
   * `KNOWN_SAVE_MS`. The marker moves only on success, so a failed write is
   * retried on the next reconcile.
   */
  function saveKnown(force = false): Promise<void> {
    const shape = shapeOf(known);
    if (!(force || shape !== knownSaved.shape || Date.now() - knownSaved.at > KNOWN_SAVE_MS)) {
      return Promise.resolve();
    }
    return Promise.resolve(context.globalState.update(KNOWN_KEY, known)).then(
      () => {
        knownSaved = { shape, at: Date.now() };
      },
      (e: Error) => {
        log(`cannot save known sessions: ${e.message}`);
        throw e;
      },
    );
  }
  /** Whether any tmux snapshot has succeeded: until one has, "no tmux session" proves nothing about Stopped. */
  let tmuxSeen = false;
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
        snapshotTmux().then(
          (snap) => {
            tmuxSeen = true;
            return snap;
          },
          (e: Error) => {
            log(`${e.message}; keeping the previous tmux bindings`);
            return tmux;
          },
        ),
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
    const rows = buildRows(sessions.values(), procs, tmux, launchers, new Set(shellPids.values()));
    // Re-read: another window may have forgotten an entry since.
    known = rememberRows(loadKnown(context.globalState.get(KNOWN_KEY)), rows, HOST, Date.now());
    saveKnown().catch(() => undefined); // logged; retried next reconcile
    tree.update(rows, tmuxSeen ? stoppedSessions(known, tmux, HOST) : []);
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
  function openSession(node?: SessionNode): void {
    const row = liveRow(node);
    if (!row) {
      return;
    }
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
  function closeDuplicates(node?: SessionNode): void {
    const row = liveRow(node);
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

  /** The current row for a clicked running node; the clicked copy may be a tick old. */
  function liveRow(node?: SessionNode): SessionRow | undefined {
    return node?.kind === "running" ? tree.row(node.row.tmuxId) ?? node.row : undefined;
  }

  /**
   * Quit Claude Code in the session with `/exit`, which lets it shut down
   * cleanly; the tmux session ends with it. Measured on CC 2.1.295: Ctrl-U
   * clears a half-typed prompt first, and Escape (sent only to a busy session)
   * interrupts the turn or dismisses a dialog.
   */
  async function stopSession(node?: SessionNode): Promise<void> {
    const row = liveRow(node);
    if (!row) {
      return;
    }
    const { name, status } = row.session;
    if (status !== "idle") {
      const choice = await vscode.window.showWarningMessage(
        `"${name}" is ${status ?? "in an unknown state"}. Stopping it interrupts what it is doing.`,
        { modal: true },
        "Stop",
      );
      if (choice !== "Stop") {
        return;
      }
    }
    try {
      const pane = paneOf(
        row.session.pid,
        (await runTmux(["list-panes", "-s", "-t", row.tmuxId, "-F", "#{pane_pid} #{pane_id}"])) ?? "",
        procs ?? new Map(),
      );
      if (!pane) {
        throw new Error(`no pane of tmux session ${row.tmuxName} runs Claude pid ${row.session.pid}`);
      }
      const keys = async (...args: string[]) => {
        await runTmux(["send-keys", "-t", pane, ...args]);
        await sleep(300);
      };
      if (status !== "idle") {
        await keys("Escape");
      }
      await keys("C-u");
      await keys("-l", "/exit");
      await keys("Enter");
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not stop "${name}": ${(e as Error).message}`);
      return;
    }
    log(`sent /exit to "${name}" (tmux ${row.tmuxName})`);
    for (const deadline = Date.now() + STOP_WAIT_MS; Date.now() < deadline; ) {
      await sleep(1000);
      try {
        if (!(await tmuxSessionExists(row.tmuxId))) {
          void reconcile(true);
          return;
        }
      } catch (e) {
        // Unknown is not gone: keep waiting, and offer the kill at the end.
        log(`checking tmux session ${row.tmuxName}: ${(e as Error).message}`);
      }
    }
    const choice = await vscode.window.showWarningMessage(
      `"${name}" has not exited after ${STOP_WAIT_MS / 1000} s.`,
      "Force Kill",
    );
    if (choice === "Force Kill") {
      try {
        await runTmux(["kill-session", "-t", row.tmuxId]);
        log(`killed tmux session ${row.tmuxName}`);
      } catch (e) {
        // Exited between the prompt and the click: nothing left to kill.
        if (!/can't find session/.test((e as Error).message)) {
          log(`cannot kill tmux session ${row.tmuxName}: ${(e as Error).message}`);
          void vscode.window.showErrorMessage(`Could not kill tmux session ${row.tmuxName}: ${(e as Error).message}`);
        }
      }
    }
    void reconcile(true);
  }

  /** False only for tmux's "can't find session" (or no server); other failures throw. */
  async function tmuxSessionExists(tmuxId: string): Promise<boolean> {
    try {
      return (await runTmux(["has-session", "-t", tmuxId])) !== undefined;
    } catch (e) {
      if (/can't find session/.test((e as Error).message)) {
        return false;
      }
      throw e;
    }
  }

  /** Resume terminals by tmux session name, so a double click does not start two. */
  const resuming = new Map<string, vscode.Terminal>();

  function resumeSession(node?: SessionNode, launcher?: string): void {
    if (node?.kind !== "stopped") {
      return;
    }
    const k = node.known;
    const pending = resuming.get(k.tmuxName);
    if (pending && vscode.window.terminals.includes(pending)) {
      pending.show();
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: k.tmuxName,
      shellPath: "bash",
      // Interactive, for the launcher functions ~/.bashrc defines.
      shellArgs: ["-ic", resumeCommand(k, launcher ?? k.launcher)],
      cwd: k.cwd,
      env: { TMUX: null, TMUX_PANE: null },
      location: vscode.TerminalLocation.Editor,
    });
    resuming.set(k.tmuxName, terminal);
    terminal.show();
    log(`resuming "${k.name}" (tmux ${k.tmuxName}) on ${launcher ?? k.launcher}`);
  }

  /** Launcher functions (`claude`, `claude_<backend>`) as an interactive bash defines them. */
  function listLaunchers(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile("bash", ["-ic", "compgen -A function claude"], { timeout: 60_000 }, (err, stdout, stderr) => {
        // compgen exits 1 when nothing matches: no launchers, not a failure.
        if (err && !(err.code === 1 && stdout.trim() === "")) {
          const detail = err.killed ? "timed out after 60 s" : stderr.trim().split("\n").slice(-3).join(" ") || err.message;
          reject(new Error(detail));
          return;
        }
        resolve([...new Set(stdout.split("\n").map((l) => l.trim()).filter((l) => /^claude(_\w+)?$/.test(l)))].sort());
      });
    });
  }

  async function resumeSessionWith(node?: SessionNode): Promise<void> {
    if (node?.kind !== "stopped") {
      return;
    }
    let launchers: string[];
    try {
      launchers = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Listing backends…" },
        listLaunchers,
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not list backends: ${(e as Error).message}`);
      return;
    }
    if (launchers.length === 0) {
      void vscode.window.showErrorMessage("No claude / claude_<backend> launcher is defined in an interactive bash.");
      return;
    }
    const last = node.known.launcher;
    const pick = await vscode.window.showQuickPick(
      launchers.map((l) => ({ label: backendLabel(l), description: l === last ? `${l} (last used)` : l, launcher: l })),
      { title: `Resume "${node.known.name}" with backend`, placeHolder: backendLabel(last) },
    );
    if (pick) {
      resumeSession(node, pick.launcher);
    }
  }

  function forgetSession(node?: SessionNode): void {
    if (node?.kind !== "stopped") {
      return;
    }
    known = loadKnown(context.globalState.get(KNOWN_KEY)).filter(
      (k) => !(k.host === node.known.host && k.tmuxName === node.known.tmuxName),
    );
    saveKnown(true).then(
      () => void reconcile(false),
      (e: Error) => void vscode.window.showErrorMessage(`Could not forget "${node.known.name}": ${e.message}`),
    );
  }

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("claudeTabStatus.sessions", tree),
    vscode.commands.registerCommand("claudeTabStatus.openSession", openSession),
    vscode.commands.registerCommand("claudeTabStatus.closeDuplicateTabs", closeDuplicates),
    vscode.commands.registerCommand("claudeTabStatus.stopSession", stopSession),
    vscode.commands.registerCommand("claudeTabStatus.resumeSession", (n?: SessionNode) => resumeSession(n)),
    vscode.commands.registerCommand("claudeTabStatus.resumeSessionWith", resumeSessionWith),
    vscode.commands.registerCommand("claudeTabStatus.forgetSession", forgetSession),
    vscode.commands.registerCommand("claudeTabStatus.refreshSessions", () => reconcile(true)),
    vscode.window.onDidOpenTerminal(async (t) => {
      await track(t);
      void reconcile(true);
    }),
    vscode.window.onDidCloseTerminal((t) => {
      shellPids.delete(t);
      for (const pending of [opened, resuming]) {
        for (const [id, o] of pending) {
          if (o === t) {
            pending.delete(id);
          }
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
