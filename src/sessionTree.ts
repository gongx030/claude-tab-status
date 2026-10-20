import * as vscode from "vscode";
import { backendLabel, SessionRow } from "./sessionList";
import { ClaudeStatus } from "./titleFormatter";

const STATUS_ICON: Record<ClaudeStatus, vscode.ThemeIcon> = {
  working: new vscode.ThemeIcon("sync~spin"),
  waiting: new vscode.ThemeIcon("bell", new vscode.ThemeColor("charts.orange")),
  idle: new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green")),
};

/** The sidebar list: one item per tmux session running Claude Code. */
export class SessionTreeProvider implements vscode.TreeDataProvider<SessionRow> {
  private rows: SessionRow[] = [];
  private shown = "";
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  /** Replace the rows; the view redraws only when something it shows changed. */
  update(rows: SessionRow[]): void {
    this.rows = rows;
    const shown = JSON.stringify(
      rows.map((r) => [r.tmuxId, r.tmuxName, r.launcher, r.session.name, r.session.status, r.session.cwd, r.terminals.length]),
    );
    if (shown !== this.shown) {
      this.shown = shown;
      this.changed.fire();
    }
  }

  row(tmuxId: string): SessionRow | undefined {
    return this.rows.find((r) => r.tmuxId === tmuxId);
  }

  getChildren(element?: SessionRow): SessionRow[] {
    return element ? [] : this.rows;
  }

  getTreeItem(row: SessionRow): vscode.TreeItem {
    const { session } = row;
    const item = new vscode.TreeItem(session.name, vscode.TreeItemCollapsibleState.None);
    item.id = row.tmuxId;
    const parts = [backendLabel(row.launcher), session.status ?? "unknown"];
    if (row.terminals.length === 1) {
      parts.push("open");
    } else if (row.terminals.length > 1) {
      parts.push(`⚠ open in ${row.terminals.length} tabs`);
    }
    item.description = parts.join(" · ");
    item.iconPath = session.status ? STATUS_ICON[session.status] : new vscode.ThemeIcon("question");
    item.tooltip = [
      session.name,
      `tmux session: ${row.tmuxName}`,
      `launcher: ${row.launcher}`,
      ...(session.cwd ? [`directory: ${session.cwd}`] : []),
      `Claude pid: ${session.pid}`,
    ].join("\n");
    item.contextValue = row.terminals.length > 1 ? "claudeSession.duplicate" : "claudeSession";
    item.command = { command: "claudeTabStatus.openSession", title: "Open in Terminal", arguments: [row] };
    return item;
  }
}
