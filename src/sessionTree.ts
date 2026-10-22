import * as vscode from "vscode";
import { backendLabel, KnownSession, SessionRow } from "./sessionList";
import { ClaudeStatus } from "./titleFormatter";

const STATUS_ICON: Record<ClaudeStatus, vscode.ThemeIcon> = {
  working: new vscode.ThemeIcon("sync~spin"),
  waiting: new vscode.ThemeIcon("bell", new vscode.ThemeColor("charts.orange")),
  idle: new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green")),
};
const STOPPED_ICON = new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("disabledForeground"));

export type SessionNode =
  | { kind: "group"; group: "running" | "stopped" }
  | { kind: "running"; row: SessionRow }
  | { kind: "stopped"; known: KnownSession };

/** The sidebar: a Running group of live tmux sessions and a Stopped group of resumable ones. */
export class SessionTreeProvider implements vscode.TreeDataProvider<SessionNode> {
  private rows: SessionRow[] = [];
  private stopped: KnownSession[] = [];
  private shown = "";
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  /** Replace the contents; the view redraws only when something it shows changed. */
  update(rows: SessionRow[], stopped: KnownSession[]): void {
    this.rows = rows;
    this.stopped = stopped;
    const shown = JSON.stringify([
      rows.map((r) => [r.tmuxId, r.tmuxName, r.launcher, r.unrecorded, r.session.name, r.session.status, r.session.cwd, r.terminals.length]),
      stopped.map((k) => [k.tmuxName, k.launcher, k.name, k.cwd]),
    ]);
    if (shown !== this.shown) {
      this.shown = shown;
      this.changed.fire();
    }
  }

  row(tmuxId: string): SessionRow | undefined {
    return this.rows.find((r) => r.tmuxId === tmuxId);
  }

  getChildren(node?: SessionNode): SessionNode[] {
    if (!node) {
      if (this.rows.length === 0 && this.stopped.length === 0) {
        return []; // the welcome text
      }
      const groups: SessionNode[] = [{ kind: "group", group: "running" }];
      if (this.stopped.length > 0) {
        groups.push({ kind: "group", group: "stopped" });
      }
      return groups;
    }
    if (node.kind !== "group") {
      return [];
    }
    return node.group === "running"
      ? this.rows.map((row) => ({ kind: "running", row }))
      : this.stopped.map((known) => ({ kind: "stopped", known }));
  }

  getTreeItem(node: SessionNode): vscode.TreeItem {
    switch (node.kind) {
      case "group": {
        const running = node.group === "running";
        const n = running ? this.rows.length : this.stopped.length;
        const item = new vscode.TreeItem(`${running ? "Running" : "Stopped"} (${n})`, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${node.group}`;
        return item;
      }
      case "running":
        return runningItem(node.row);
      case "stopped":
        return stoppedItem(node.known);
    }
  }
}

function runningItem(row: SessionRow): vscode.TreeItem {
  const { session } = row;
  const item = new vscode.TreeItem(session.name, vscode.TreeItemCollapsibleState.None);
  item.id = `running:${row.tmuxId}`;
  const backend = row.unrecorded && row.launcher !== undefined ? `${backendLabel(row.launcher)} (inferred)` : backendLabel(row.launcher);
  // The icon carries the status, so the text names only the backend.
  item.description = row.terminals.length > 1 ? `${backend} · ⚠ open in ${row.terminals.length} tabs` : backend;
  item.iconPath = session.status ? STATUS_ICON[session.status] : new vscode.ThemeIcon("question");
  item.tooltip = [
    session.name,
    `status: ${session.status ?? "unknown"}`,
    `tmux session: ${row.tmuxName}`,
    !row.unrecorded
      ? `launcher: ${row.launcher}`
      : row.launcher !== undefined
        ? `launcher: ${row.launcher} (inferred from Claude's config dir; the tmux session has no CC_BACKEND record)`
        : "launcher: unrecorded (no CC_BACKEND record, and Claude's config dir does not name one)",
    ...(session.cwd ? [`directory: ${session.cwd}`] : []),
    `Claude pid: ${session.pid}`,
  ].join("\n");
  // claudeSession.<status>[.duplicate]: package.json menus key on both parts.
  item.contextValue = `claudeSession.${session.status ?? "unknown"}${row.terminals.length > 1 ? ".duplicate" : ""}`;
  item.command = { command: "claudeTabStatus.openSession", title: "Open in Terminal", arguments: [{ kind: "running", row }] };
  return item;
}

function stoppedItem(known: KnownSession): vscode.TreeItem {
  const item = new vscode.TreeItem(known.name, vscode.TreeItemCollapsibleState.None);
  item.id = `stopped:${known.tmuxName}`;
  item.description = backendLabel(known.launcher);
  item.iconPath = STOPPED_ICON;
  item.tooltip = [
    known.name,
    `tmux session: ${known.tmuxName} (not running)`,
    `last backend: ${known.launcher ?? "unrecorded"}`,
    ...(known.cwd ? [`directory: ${known.cwd}`] : []),
    `last seen: ${new Date(known.lastSeen).toLocaleString()}`,
  ].join("\n");
  item.contextValue = "claudeStopped";
  item.command = { command: "claudeTabStatus.resumeSession", title: "Resume", arguments: [{ kind: "stopped", known }] };
  return item;
}
