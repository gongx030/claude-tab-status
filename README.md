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

That is all it does. It has no sidebar, notifications, network access or
telemetry.

## Install

```bash
npm install
npx @vscode/vsce package               # -> claude-tab-status-0.1.0.vsix
code --install-extension claude-tab-status-0.1.0.vsix
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
  few dozen bytes per tab), in case another program replaced them.

Diagnostics are written to the **Claude Tab Status** output channel.

## Limitations

- `sessions/<pid>.json` is an internal Claude Code file (observed in 2.1.281),
  not a documented interface. If its format changes, the extension stops
  updating titles and logs why; it does not show wrong ones.
- A session running inside tmux is not under a VS Code terminal shell, so it
  is not labelled.
- Linux and macOS only. A session file whose pid now belongs to a process started
  after the session (a recycled pid) is ignored.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeTabStatus.enabled` | `true` | Turning it off resets the titles this extension set |
| `claudeTabStatus.refreshIntervalMs` | `3000` | Process-table reconcile interval |
