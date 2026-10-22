import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { processConfigDir, readSessions, SessionScan, sessionDirs } from "./claudeSessions";
import {
  Backend,
  backendForRecord,
  invalidSessionName,
  LAUNCHER_BIN,
  launchCommand,
  launcherOfConfigDir,
  parseTargets,
  resolveLauncher,
  uniqueSessionName,
} from "./launcher";
import { Binding, StatusStore } from "./statusStore";
import { buildRows, KnownSession, paneOf, rememberRows, SessionRow, stoppedSessions, withFolder } from "./sessionList";
import { SessionNode, SessionTreeProvider } from "./sessionTree";
import { bindTerminals, ProcTable, snapshotProcesses } from "./terminalTracker";
import { BACKEND_VAR, BackendRecords, EMPTY_TMUX, snapshotTmux, tmux as runTmux, TmuxSnapshot } from "./tmuxClients";
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
      (k.launcher === undefined || typeof k.launcher === "string") &&
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
  let scan: SessionScan | undefined; // the last read, which holds a session whose file is unreadable
  const backends = new BackendRecords();
  /** Launcher inferred from each Claude process's config dir, keyed by pid and checked against its start time. */
  const inferredCache = new Map<number, { startMs?: number; launcher?: string }>();
  /** Claude pids whose omission from the list was logged; each is logged once, not every reconcile. */
  const omissionsLogged = new Set<number>();
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
    scan = await readSessions(dirs, log, scan);
    const { sessions, unreadable } = scan;
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
    const inferred = await inferLaunchers(sessions.keys(), procs);
    if (disposed) {
      return;
    }
    for (const pid of omissionsLogged) {
      if (!sessions.has(pid)) {
        omissionsLogged.delete(pid);
      }
    }
    const rows = buildRows(sessions.values(), procs, tmux, launchers, new Set(shellPids.values()), inferred, (pid, tmuxId, reason) => {
      if (!omissionsLogged.has(pid)) {
        omissionsLogged.add(pid);
        log(`Claude pid ${pid} in tmux session ${tmux.sessions.get(tmuxId) ?? tmuxId} is not listed: ${reason}`);
      }
    });
    for (const r of rows) {
      if (r.unrecorded) {
        log(
          `tmux session ${r.tmuxName} has no ${BACKEND_VAR} record; ` +
            (r.launcher !== undefined
              ? `launcher ${r.launcher} inferred from the config dir of Claude pid ${r.session.pid}`
              : `no launcher can be inferred from the config dir of Claude pid ${r.session.pid}`),
        );
      }
    }
    // Re-read: another window may have forgotten an entry since.
    known = rememberRows(loadKnown(context.globalState.get(KNOWN_KEY)), rows, HOST, Date.now());
    saveKnown().catch(() => undefined); // logged; retried next reconcile
    tree.update(rows, tmuxSeen ? stoppedSessions(known, tmux, HOST, rows) : []);
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

  /**
   * Launcher per Claude pid, from its config dir, for tmux sessions without a
   * `CC_BACKEND` record. A process's environment is fixed at exec, so each
   * pid is read once per process (a recycled pid has a new start time).
   */
  async function inferLaunchers(pids: Iterable<number>, table: ProcTable): Promise<Map<number, string>> {
    const live = new Set(pids);
    for (const pid of inferredCache.keys()) {
      if (!live.has(pid)) {
        inferredCache.delete(pid);
      }
    }
    await Promise.all(
      [...live].map(async (pid) => {
        const startMs = table.get(pid)?.startMs;
        if (startMs === undefined || inferredCache.get(pid)?.startMs === startMs) {
          return;
        }
        const dir = await processConfigDir(pid);
        inferredCache.set(pid, { startMs, launcher: dir === undefined ? undefined : launcherOfConfigDir(dir) });
      }),
    );
    const out = new Map<number, string>();
    for (const [pid, { launcher }] of inferredCache) {
      if (launcher !== undefined) {
        out.set(pid, launcher);
      }
    }
    return out;
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
      await typeCommand(row, "/exit");
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

  /**
   * Type a slash command into the pane running the row's Claude Code, as a
   * person would. Measured on CC 2.1.295: Escape (sent only to a busy
   * session) interrupts the turn or dismisses a dialog, and Ctrl-U clears a
   * half-typed prompt so the command is not appended to it.
   */
  async function typeCommand(row: SessionRow, command: string): Promise<void> {
    const pane = paneOf(
      row.session.pid,
      (await runTmux(["list-panes", "-s", "-t", row.tmuxId, "-F", "#{pane_pid} #{pane_id} #{pane_tty}"])) ?? "",
      procs ?? new Map(),
    );
    if (!pane) {
      throw new Error(`no pane of tmux session ${row.tmuxName} runs Claude pid ${row.session.pid}`);
    }
    const keys = async (...args: string[]) => {
      await runTmux(["send-keys", "-t", pane, ...args]);
      await sleep(300);
    };
    if (row.session.status !== "idle") {
      await keys("Escape");
    }
    await keys("C-u");
    await keys("-l", command);
    await keys("Enter");
  }

  /** How long Clear Context waits for Claude Code to start the new conversation. */
  const CLEAR_WAIT_MS = 15_000;

  /**
   * Run /clear in the session. It keeps its name and starts a new
   * conversation id, which is the proof the clear happened; unified-agent-sdk
   * resumes the name's newest conversation, so a restart continues this one.
   */
  async function clearSession(node?: SessionNode): Promise<void> {
    const row = liveRow(node);
    if (!row) {
      return;
    }
    const { name, status, sessionId } = row.session;
    // The menu item is greyed out unless idle (package.json enablement); the
    // row may still be a tick stale, so check the current state too.
    if (status !== "idle") {
      void vscode.window.showInformationMessage(
        `"${name}" is ${status ?? "in an unknown state"}; Clear Context needs an idle session.`,
      );
      return;
    }
    try {
      await typeCommand(row, "/clear");
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not clear "${name}": ${(e as Error).message}`);
      return;
    }
    log(`sent /clear to "${name}" (tmux ${row.tmuxName})`);
    for (const deadline = Date.now() + CLEAR_WAIT_MS; Date.now() < deadline; ) {
      await sleep(1000);
      await reconcile(false);
      const now = tree.row(row.tmuxId)?.session.sessionId;
      if (now !== undefined && now !== sessionId) {
        log(`"${name}" cleared: conversation ${sessionId} -> ${now}`);
        void vscode.window.showInformationMessage(`Cleared "${name}".`);
        return;
      }
    }
    void vscode.window.showWarningMessage(
      `Sent /clear to "${name}", but no new conversation appeared within ${CLEAR_WAIT_MS / 1000} s.`,
    );
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

  /** Launch terminals by tmux session name, so a double click does not start two. */
  const launching = new Map<string, vscode.Terminal>();

  function launcherBin(): string | undefined {
    const bin = resolveLauncher(config().get<string>("launcherPath", ""), process.env.PATH);
    if (!bin) {
      void vscode.window.showErrorMessage(
        `Cannot find ${LAUNCHER_BIN} (unified-agent-sdk). Set claudeTabStatus.launcherPath to its path.`,
      );
    }
    return bin;
  }

  /** Open an editor-area tab running the launcher for tmux session `name`. */
  function launch(name: string, backend: string, cwd: string): void {
    const pending = launching.get(name);
    if (pending && vscode.window.terminals.includes(pending)) {
      pending.show();
      return;
    }
    const bin = launcherBin();
    if (!bin) {
      return;
    }
    const terminal = vscode.window.createTerminal({
      name,
      shellPath: "bash",
      // Non-interactive: the launcher needs nothing from ~/.bashrc.
      shellArgs: ["-c", launchCommand(bin, backend, name, cwd)],
      cwd,
      // tmux refuses to start a client inside another tmux client. Claude
      // Code's own title would overwrite the one this extension writes (in a
      // session this starts; a reattached one keeps its own environment).
      env: { TMUX: null, TMUX_PANE: null, CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" },
      location: vscode.TerminalLocation.Editor,
    });
    launching.set(name, terminal);
    terminal.show();
    log(`launching tmux session ${name} on ${backend} in ${cwd}`);
  }

  /**
   * Launch targets, listed once per launcher (a Python start on a slow
   * mount). The pending listing is shared, so overlapping commands start one.
   */
  let targets: Promise<Backend[] | undefined> | undefined;

  function listTargets(): Promise<Backend[] | undefined> {
    targets ??= fetchTargets().then((t) => {
      if (!t) {
        targets = undefined; // retry on the next command
      }
      return t;
    });
    return targets;
  }

  async function fetchTargets(): Promise<Backend[] | undefined> {
    const bin = launcherBin();
    if (!bin) {
      return undefined;
    }
    try {
      const stdout = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Listing backends…" },
        () =>
          new Promise<string>((resolve, reject) =>
            execFile(bin, ["--list-json"], { timeout: 180_000 }, (err, out, errOut) => {
              if (err) {
                const detail = err.killed ? "timed out after 180 s" : errOut.trim().split("\n").slice(-3).join(" ");
                reject(new Error(detail || err.message));
              } else {
                resolve(out);
              }
            }),
          ),
      );
      const parsed = parseTargets(stdout);
      if (parsed.length === 0) {
        void vscode.window.showErrorMessage(`${bin} --list-json printed no backends.`);
        return undefined;
      }
      return parsed;
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not list backends: ${(e as Error).message}`);
      return undefined;
    }
  }

  async function pickBackend(title: string, last?: string): Promise<string | undefined> {
    const all = await listTargets();
    if (!all) {
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((t) => ({
        label: t.name,
        description: t.name === last ? `${t.description} (last used)` : t.description,
      })),
      { title, placeHolder: last },
    );
    return pick?.label;
  }

  async function newSession(): Promise<void> {
    const backend = await pickBackend("New Claude session: backend");
    if (!backend) {
      return;
    }
    const folder = vscode.window.activeTextEditor
      ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
      : undefined;
    const defaultDir = (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
    // Fresh, not the last snapshot, which is empty until tmux was first seen.
    let live: string[] = [...tmux.sessions.values()];
    try {
      live = ((await runTmux(["list-sessions", "-F", "#{session_name}"])) ?? "").split("\n").filter(Boolean);
    } catch (e) {
      log(`listing tmux sessions for New Session: ${(e as Error).message}; using the last snapshot`);
    }
    const taken = new Set([...live, ...known.filter((k) => k.host === HOST).map((k) => k.tmuxName)]);
    const suggested = uniqueSessionName(path.basename(defaultDir ?? "claude"), taken);
    const name = await vscode.window.showInputBox({
      title: "New Claude session: name",
      prompt: "Also the tmux session name; resuming it later continues its newest conversation.",
      value: suggested,
      validateInput: (v) => invalidSessionName(v) ?? (taken.has(v) ? `A session named "${v}" already exists.` : undefined),
    });
    if (!name) {
      return;
    }
    const choose = "Choose folder…";
    const dirPick = await vscode.window.showQuickPick(
      [
        ...(defaultDir ? [{ label: defaultDir, description: "workspace folder" }] : []),
        ...(vscode.workspace.workspaceFolders ?? [])
          .map((f) => f.uri.fsPath)
          .filter((p) => p !== defaultDir)
          .map((p) => ({ label: p, description: "workspace folder" })),
        { label: choose, description: "" },
      ],
      { title: `New Claude session "${name}": folder` },
    );
    if (!dirPick) {
      return;
    }
    let dir = dirPick.label;
    if (dir === choose) {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        defaultUri: defaultDir ? vscode.Uri.file(defaultDir) : undefined,
        openLabel: "Start session here",
      });
      if (!uris?.[0]) {
        return;
      }
      dir = uris[0].fsPath;
    }
    launch(name, backend, dir);
  }

  /**
   * Resume a stopped session on `backend`, else the one it last ran on (asked
   * for when its record names no current backend). The launcher resumes the
   * newest conversation of that NAME in that folder, so the session is
   * resumed by its Claude Code name, which is also its tmux name when the
   * launcher or a ~/.bashrc wrapper created it.
   */
  async function resumeSession(node?: SessionNode, backend?: string): Promise<void> {
    if (node?.kind !== "stopped") {
      return;
    }
    const k = node.known;
    const manual = `resume it with \`claude -r ${k.sessionId}\` in its folder`;
    if (!k.cwd) {
      // Conversations are found by name AND folder; any other folder starts a new one.
      void vscode.window.showErrorMessage(`"${k.name}" has no recorded folder; ${manual}.`);
      return;
    }
    if (invalidSessionName(k.name)) {
      void vscode.window.showErrorMessage(`"${k.name}" cannot be resumed by name; ${manual}.`);
      return;
    }
    if (!backend) {
      const all = await listTargets();
      if (!all) {
        return;
      }
      backend =
        backendForRecord(all, k.launcher) ??
        (await pickBackend(
          k.launcher === undefined
            ? `"${k.name}" has no known backend: resume with`
            : `"${k.name}" last ran on ${k.launcher}, which is not a backend: resume with`,
        ));
      if (!backend) {
        return;
      }
    }
    launch(k.name, backend, k.cwd);
  }

  async function resumeSessionWith(node?: SessionNode): Promise<void> {
    if (node?.kind !== "stopped") {
      return;
    }
    const all = await listTargets();
    const last = all && backendForRecord(all, node.known.launcher);
    const backend = await pickBackend(`Resume "${node.known.name}" with backend`, last);
    if (backend) {
      await resumeSession(node, backend);
    }
  }

  /**
   * Set the folder a stopped session's next Resume starts in. Its
   * conversation is filed under the old folder and stays there; Resume
   * continues the name's newest conversation in the new one, else starts one.
   */
  async function changeFolder(node?: SessionNode): Promise<void> {
    if (node?.kind !== "stopped") {
      return;
    }
    const k = node.known;
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: k.cwd ? vscode.Uri.file(k.cwd) : undefined,
      openLabel: "Resume here",
      title: `"${k.name}": folder to resume in`,
    });
    const dir = uris?.[0]?.fsPath;
    if (!dir || dir === k.cwd) {
      return;
    }
    // A session resumed while the dialog was open would have its live folder
    // written back over this one by the next reconcile. "=" matches the name exactly.
    let running: boolean;
    try {
      running = await tmuxSessionExists(`=${k.tmuxName}`);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not check whether "${k.name}" is running: ${(e as Error).message}`);
      return;
    }
    if (running) {
      void vscode.window.showErrorMessage(`"${k.name}" is running again; change its folder after it stops.`);
      return;
    }
    // Re-read: another window may have forgotten it since.
    const updated = withFolder(loadKnown(context.globalState.get(KNOWN_KEY)), k.host, k.tmuxName, dir);
    if (!updated) {
      void vscode.window.showErrorMessage(`"${k.name}" is no longer in the Stopped list.`);
      return;
    }
    known = updated;
    try {
      await saveKnown(true);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not change the folder of "${k.name}": ${(e as Error).message}`);
      return;
    }
    log(`"${k.name}" (tmux ${k.tmuxName}) now resumes in ${dir}, was ${k.cwd ?? "unrecorded"}`);
    void reconcile(false);
    void vscode.window.showInformationMessage(
      `"${k.name}" now resumes in ${dir}.` + (k.cwd ? ` Its conversation in ${k.cwd} does not follow.` : ""),
    );
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
    vscode.commands.registerCommand("claudeTabStatus.clearSession", clearSession),
    vscode.commands.registerCommand("claudeTabStatus.resumeSession", (n?: SessionNode) => resumeSession(n)),
    vscode.commands.registerCommand("claudeTabStatus.resumeSessionWith", resumeSessionWith),
    vscode.commands.registerCommand("claudeTabStatus.changeFolder", changeFolder),
    vscode.commands.registerCommand("claudeTabStatus.forgetSession", forgetSession),
    vscode.commands.registerCommand("claudeTabStatus.refreshSessions", () => reconcile(true)),
    vscode.commands.registerCommand("claudeTabStatus.newSession", newSession),
    vscode.window.onDidOpenTerminal(async (t) => {
      await track(t);
      void reconcile(true);
    }),
    vscode.window.onDidCloseTerminal((t) => {
      shellPids.delete(t);
      for (const pending of [opened, launching]) {
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
      if (e.affectsConfiguration("claudeTabStatus.launcherPath")) {
        targets = undefined;
      }
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
