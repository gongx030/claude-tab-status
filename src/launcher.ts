import * as fs from "fs";
import * as path from "path";

/**
 * unified-agent-sdk's launcher, which creates every session this list shows:
 * `unified-agent-launch <backend> --session NAME --cwd DIR [claude args...]`
 * creates or reattaches tmux session NAME and records its backend in it.
 */
export const LAUNCHER_BIN = "unified-agent-launch";
/** Where the launcher lives on the hosts this was written for, when it is not on PATH. */
export const FALLBACK_LAUNCHER = "/cv/data/gongw13/miniforge3/envs/py311c/bin/unified-agent-launch";

/** A launch target from `unified-agent-launch --list`. */
export interface Backend {
  name: string;
  description: string;
}

/**
 * `--list --json` output, else `--list`'s `name<TAB>description` lines. A
 * launcher predating `--json` ignores it and prints the lines.
 */
export function parseTargets(stdout: string): Backend[] {
  try {
    const raw: unknown = JSON.parse(stdout);
    if (Array.isArray(raw)) {
      return raw
        .map((t) => (typeof t === "string" ? { name: t, description: "" } : t))
        .filter((t): t is Backend => typeof t?.name === "string")
        .map((t) => ({ name: t.name, description: typeof t.description === "string" ? t.description : "" }));
    }
  } catch {
    // not JSON
  }
  const targets: Backend[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line.trim());
    if (m) {
      targets.push({ name: m[1], description: (m[2] ?? "").trim() });
    }
  }
  return targets;
}

/**
 * The backend a `CC_BACKEND` record names. The launcher records the shell
 * function name of the backend it launched (`claude-build` -> `claude_build`).
 */
export function backendOfLauncher(launcher: string): string {
  return launcher.replace(/_/g, "-");
}

/** Why `name` cannot name a tmux session, or undefined when it can. */
export function invalidSessionName(name: string): string | undefined {
  if (name === "") {
    return "Enter a name.";
  }
  // tmux reads "." and ":" in a target as window and pane separators.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return "Use letters, digits, '-' and '_' only.";
  }
  return undefined;
}

/** `base` folded to a valid session name, suffixed 2, 3, ... until no session in `taken` has it. */
export function uniqueSessionName(base: string, taken: Set<string>): string {
  const stem = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "claude";
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
 * The `bash -c` command that starts or resumes tmux session `name` on
 * `backend` in `cwd`. A failure (e.g. a refused backend) holds the tab open
 * so its message can be read.
 */
export function launchCommand(bin: string, backend: string, name: string, cwd: string, extra: string[] = []): string {
  const argv = [bin, backend, "--session", name, "--cwd", cwd, ...extra].map(q).join(" ");
  return `${argv} || { rc=$?; echo; read -rp "exited $rc; Enter to close " _; }`;
}

/** The configured launcher, else the first on `pathEnv`, else the fallback; undefined if none is executable. */
export function resolveLauncher(configured: string, pathEnv: string | undefined): string | undefined {
  const executable = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (configured) {
    return executable(configured) ? configured : undefined;
  }
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir && executable(path.join(dir, LAUNCHER_BIN))) {
      return path.join(dir, LAUNCHER_BIN);
    }
  }
  return executable(FALLBACK_LAUNCHER) ? FALLBACK_LAUNCHER : undefined;
}
