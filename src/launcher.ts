import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * unified-agent-sdk's launcher, which creates every session this list shows:
 * `unified-agent-launch <backend> --session NAME --cwd DIR` creates or
 * reattaches tmux session NAME, records its backend in it, and resumes the
 * newest conversation named NAME in DIR.
 */
export const LAUNCHER_BIN = "unified-agent-launch";
/** Where the launcher lives on the hosts this was written for, when it is not on PATH. */
export const FALLBACK_LAUNCHER = "/cv/data/gongw13/miniforge3/envs/py311c/bin/unified-agent-launch";

/** A launch target from `unified-agent-launch --list-json`. */
export interface Backend {
  /** Backend name the launcher takes, e.g. `claude-build`. */
  name: string;
  description: string;
  /** What the launcher records in `CC_BACKEND` for it, e.g. `claude_build`. */
  launcher: string;
  /** Other `CC_BACKEND` values meaning this backend, e.g. `claude_max` for `claude`. */
  aliases: string[];
}

/** The backend a recorded `CC_BACKEND` value names, matched on its launcher or an alias; none for no record. */
export function backendForRecord(targets: Backend[], record: string | undefined): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  return targets.find((t) => t.launcher === record || t.aliases.includes(record))?.name;
}

/** The `CC_BACKEND` record of `backend`, as the launcher derives it. */
function launcherOf(backend: string): string {
  return backend.replace(/-/g, "_");
}

/**
 * The `CC_BACKEND` record of the backend whose Claude Code config dir is
 * `configDir`: backend `claude-build` runs with `~/.claude-build`, and plain
 * `claude` with `~/.claude`. Undefined for a dir not named that way.
 */
export function launcherOfConfigDir(configDir: string): string | undefined {
  const base = path.basename(configDir);
  return /^\.claude(-[A-Za-z0-9_-]+)?$/.test(base) ? launcherOf(base.slice(1)) : undefined;
}

/**
 * `--list-json` output (`[{backend, label, launcher, aliases}]`), else
 * `--list`'s `backend<TAB>label` lines.
 */
export function parseTargets(stdout: string): Backend[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    raw = undefined;
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((t) => typeof t?.backend === "string")
      .map((t) => ({
        name: t.backend,
        description: typeof t.label === "string" ? t.label : "",
        launcher: typeof t.launcher === "string" ? t.launcher : launcherOf(t.backend),
        aliases: Array.isArray(t.aliases) ? t.aliases.filter((a: unknown) => typeof a === "string") : [],
      }));
  }
  const targets: Backend[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line.trim());
    if (m) {
      targets.push({ name: m[1], description: (m[2] ?? "").trim(), launcher: launcherOf(m[1]), aliases: [] });
    }
  }
  return targets;
}

/** Why `name` cannot name a session, or undefined when it can. */
export function invalidSessionName(name: string): string | undefined {
  if (name === "") {
    return "Enter a name.";
  }
  // tmux reads "." and ":" in a target as window and pane separators.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return "Use letters, digits, '-' and '_' only.";
  }
  // The launcher's rules: a leading "-" reads as a flag, a UUID as a conversation id.
  if (name.startsWith("-")) {
    return "A name cannot start with '-'.";
  }
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(name)) {
    return "A name cannot look like a conversation id (UUID).";
  }
  return undefined;
}

/** `base` folded to a valid session name, suffixed 2, 3, ... until no session in `taken` has it. */
export function uniqueSessionName(base: string, taken: Set<string>): string {
  let stem = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (invalidSessionName(stem)) {
    stem = "claude";
  }
  if (!taken.has(stem)) {
    return stem;
  }
  for (let i = 2; ; i++) {
    if (!taken.has(`${stem}${i}`)) {
      return `${stem}${i}`;
    }
  }
}

/** POSIX single-quoted shell word. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `bash -c` command that starts or resumes session `name` on `backend`
 * in `cwd`. A failure holds the tab open so the launcher's reason, printed
 * on stderr above, can be read. Exit 3 is a refusal that started nothing
 * (backend or folder mismatch, conversation already live); anything else is
 * a usage error or missing tmux.
 *
 * The launcher only creates the session (`--detach`); bash then becomes the
 * tmux client with `exec`. A shell left as the client's parent makes VS Code
 * ask "terminate running processes?" when the tab is closed, which a tab from
 * Open in Terminal (tmux as the shell process) does not.
 */
export function launchCommand(bin: string, backend: string, name: string, cwd: string): string {
  const argv = [bin, backend, "--session", name, "--cwd", cwd, "--detach"].map(q).join(" ");
  // -d takes the session from any other client, as the launcher's own attach does.
  const attach = ["tmux", "attach-session", "-d", "-t", `=${name}`].map(q).join(" ");
  return (
    `${argv} && exec ${attach} || { rc=$?; echo; ` +
    `if [ $rc -eq 3 ]; then echo "Refused; nothing was started."; else echo "Failed (exit $rc)."; fi; ` +
    `read -rp "Enter to close " _; }`
  );
}

/**
 * The configured launcher (`~` expanded), else the first on `pathEnv`, else
 * the fallback when the current user owns it; undefined if none is an
 * executable file.
 */
export function resolveLauncher(configured: string, pathEnv: string | undefined): string | undefined {
  const executable = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (configured) {
    const p = configured.replace(/^~(?=$|\/)/, os.homedir());
    return executable(p) ? p : undefined;
  }
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir && executable(path.join(dir, LAUNCHER_BIN))) {
      return path.join(dir, LAUNCHER_BIN);
    }
  }
  // On a shared host, never run another user's launcher.
  try {
    if (executable(FALLBACK_LAUNCHER) && fs.statSync(FALLBACK_LAUNCHER).uid === os.userInfo().uid) {
      return FALLBACK_LAUNCHER;
    }
  } catch {
    // no such file
  }
  return undefined;
}
