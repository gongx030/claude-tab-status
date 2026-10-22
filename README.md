# claude-tab-status

When several Claude Code sessions run in VS Code integrated terminals, this
extension shows each session's name and state in its terminal tab:

```text
VCC-transfer ●     working: Claude is processing a turn, running tools, or waiting on a shell command it started
ADKG 🟠            waiting: Claude is blocked on you (permission prompt, question, dialog)
MYCN-analysis 🟢   idle: the turn is complete and nothing Claude started is still running
```

The waiting and idle marks are colour emoji because VS Code offers no way to
colour a tab the extension did not create: `TerminalOptions.color` applies only
at creation, and the change-color command acts on the active terminal only.

It also adds a **Claude Sessions** view to the activity bar, listing every
Claude Code session that runs in a tmux session on the default tmux server:

```text
▾ Running (3)
    disease_kg   build
    autodev      claude
    vcc          claude · ⚠ open in 2 tabs
▾ Stopped (1)
    autodev4     build
```

Each row shows the session name and the backend; the icon shows the state
(working, waiting or idle). Clicking a row shows the tab already attached to that
tmux session, or opens one in the editor area running `tmux attach-session`, so one session never
gets a second tab from the list. A session attached in more than one tab (for
example by a hand-typed `tmux attach`) is marked ⚠ and offers **Close
Duplicate Tabs**. Rows cannot be dragged into the terminal panel: VS Code has
no API for opening a terminal from a drop.

**New Session…** (the `+` in the view's title bar) starts a session from the
list: pick a backend (from `unified-agent-launch --list-json`), a name (the
workspace folder's name by default, suffixed `2`, `3`, ... when taken) and a
folder. It runs `unified-agent-launch <backend> --session <name> --cwd <folder>`
in a new editor-area tab, which creates tmux session `<name>` and records its
backend, so the session is listed as soon as Claude Code starts. Several
sessions can share one folder under different names. No `~/.bashrc` function is
needed.

Right-click a running session for **Stop Session**: the extension clears the
prompt and sends `/exit`, so Claude Code shuts down cleanly and its tmux session
ends. A session that is working or waiting asks for confirmation first (it is
interrupted with Escape), and one that has not exited after 15 s offers **Force
Kill** (`tmux kill-session`).

**Clear Context** (same menu) types `/clear` into the session the same way,
and confirms once Claude Code has started the new conversation. It is greyed
out unless the session is idle, the same rule as
`unified-agent-launch --clear-session`: clearing mid-turn would discard the
turn. The session keeps its name, and unified-agent-sdk resumes a
name's newest conversation, so restarting it later continues the cleared one.

Every listed session is remembered (name, backend, directory, conversation id),
so when its tmux session ends, by Stop, `/exit` or a crash, it moves to a
**Stopped** group instead of vanishing. Clicking a stopped session resumes it on
its last backend in the editor area: `unified-agent-launch <backend> --session
<name> --cwd <directory>` reopens tmux session `<name>` and continues that
name's newest conversation in that directory. It runs the launcher directly,
not a `~/.bashrc` wrapper, so anything a wrapper adds beyond `cd` and the
launcher is not applied. A session whose name is not a valid tmux name (or
has no recorded directory) is not resumed; the error gives the
`claude -r <conversation id>` to run by hand. **Resume with Backend…** picks
another backend from `unified-agent-launch --list-json`, which is how a session
switches backend. **Change Folder…** sets the directory the next Resume
starts in. A conversation is filed under the directory it ran in, so it does
not follow: Resume continues the name's newest conversation in the new
directory, else starts a new one. **Forget** removes it from the list.

A stopped row names its tmux session beside the backend (`build · autodev4`)
when that is not the row's label, since a session is remembered per tmux name
and two tmux sessions that ran the same Claude session name would otherwise
render identically. The group also retires itself: every ten minutes the
extension drops the entries Resume could no longer reopen — their directory is
gone (a deleted worktree), or their conversation is no longer on disk — and
logs each one with its reason. An entry is kept whenever the evidence is
inconclusive, such as a directory on a mount that is down, so **Forget** stays
the way to remove one that is merely unwanted.

The backend is the tmux session-environment variable `CC_BACKEND` (`claude`,
`claude_build`, ...), written at session creation by unified-agent-sdk's
launcher (and by older `~/.bashrc` wrappers). A tmux session without it (made
by hand with `tmux new`, then `claude`) is still listed, with the backend
inferred from Claude's config dir (`CLAUDE_CONFIG_DIR` of the Claude process:
`~/.claude` is `claude`, `~/.claude-build` is `build`) and shown as
`build (inferred)`, or as `unrecorded` when the dir names no backend; Resume
then asks for one. A `claude` started in a terminal outside tmux is not
listed: start it with **New Session…** instead. A Claude process in a tmux
pane that is still left out is logged once, with the reason, in the
"Claude Tab Status" output channel.

The launcher is found through `claudeTabStatus.launcherPath`, else `PATH`, else
the py311c conda environment.

It has no notifications, network access or telemetry.

## Install

```bash
npm install
npx @vscode/vsce package               # -> claude-tab-status-0.4.0.vsix
code --install-extension claude-tab-status-0.4.0.vsix
```

In a Remote-SSH window, run `code --install-extension` from a terminal on the
remote host. The extension must run where the Claude processes run (it
declares `extensionKind: ["workspace"]`).

## Required setup: turn off Claude Code's own terminal title

Claude Code sets the terminal title itself, and animates it while working.
That would overwrite the title written by this extension. Add this to
`~/.bashrc` (or `~/.zshrc`):

```bash
export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
```

An exported variable reaches every launcher that inherits the shell
environment, including wrappers such as `claude_build` and `claude_codex`.
Running sessions read it only at startup, so restart them (`claude -r <name>`)
from a terminal that has it. Until then the extension wins the tab back on its
next reconcile (every 3 s), but a busy session's tab flickers between the two
titles.

Keep `terminal.integrated.tabs.allowAgentCliTitle` at its default, `true`.

Optional: VS Code appends the terminal's folder after the title when it differs
from the workspace folder (`${cwdFolder}` in the tab description). To show only
the session name and status, set:

```json
"terminal.integrated.tabs.description": "${task}${separator}${local}"
```

## How it works

- **State.** Claude Code maintains `<config dir>/sessions/<pid>.json`. The file
  holds the session id, the name (already resolved as `/rename` over `--name`
  over the generated name), and a status of `busy`, `waiting`, `idle` or
  `shell`. Status maps as `busy`/`shell` → ●, `waiting` → 🟠, `idle` → 🟢 (`shell`:
  the turn ended but a shell command Claude started is still running).
  The extension reads every `~/.claude/sessions` and `~/.claude-*/sessions`
  directory and `$CLAUDE_CONFIG_DIR/sessions`. Directories that are the same
  on disk are read once. It needs no hooks.
- **Mapping.** One `ps -A -o pid=,ppid=,tty=` snapshot. A session belongs to
  the nearest ancestor process that is one of this window's terminal shells
  (`Terminal.processId`). Terminal text is never parsed.
- **Title.** VS Code has no API to rename a terminal the extension did not
  create. `Terminal.name` is read-only, and the `renameWithArg` command acts
  only on the active terminal, so using it would switch tabs. Instead, the
  extension writes an OSC 2 title sequence to the terminal's tty, as any
  program running in the terminal could. Focus, tabs, groups and content are
  untouched. Each write first sends the title `Claude Code`. VS Code uses
  that to classify the terminal as an agent CLI, which is what makes it show
  a program-set title instead of the process name.
- **Updates.** A file watch on the session directories, terminal
  open/close/focus events, and a `ps` reconcile every 3 s
  (`claudeTabStatus.refreshIntervalMs`). Event-driven updates write a title
  only when it changes; each reconcile tick also rewrites unchanged titles (a
  write under 100 bytes per tab), in case another program replaced them. A
  terminal whose last write failed is skipped for 10 ticks.

Diagnostics are written to the **Claude Tab Status** output channel.

## Limitations

- `sessions/<pid>.json` is an internal Claude Code file (observed in 2.1.281),
  not a documented interface. If its format changes, the extension stops
  updating titles and logs why; it does not show wrong ones.
- A session in a detached tmux session has no tab to label; it still appears
  in the sidebar.
- The sidebar counts tabs in this window only; a tab in another VS Code window
  attached to the same tmux session is not detected.
- Linux and macOS only. A session file whose pid now belongs to a process started
  after the session (a recycled pid) is ignored.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeTabStatus.enabled` | `true` | Turning it off resets the titles this extension set |
| `claudeTabStatus.refreshIntervalMs` | `3000` | Process-table reconcile interval |
| `claudeTabStatus.launcherPath` | `""` | `unified-agent-launch` that New Session and Resume run; empty: `PATH`, else the py311c environment's |
