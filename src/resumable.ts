import { promises as fsp } from "fs";
import * as path from "path";
import { KnownSession } from "./sessionList";

/**
 * Why a remembered session can no longer be resumed. Resume relaunches the
 * newest conversation of its NAME in its FOLDER, else starts a new one, so an
 * entry is spent once that folder is gone or holds no conversation at all:
 * clicking Resume could then only start a fresh one.
 */
export type Unresumable = "folder-gone" | "no-transcript";

export const UNRESUMABLE_REASON: Record<Unresumable, string> = {
  "folder-gone": "its folder no longer exists",
  "no-transcript": "its folder holds no conversation to resume",
};

/**
 * The directory Claude Code files a folder's transcripts under: the absolute
 * path with every `/`, `_` and `.` replaced by `-`, so
 * `/cv/x/disease_map/.claude/worktrees/w` becomes
 * `-cv-x-disease-map--claude-worktrees-w`.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/_.]/g, "-");
}

/** "Not there", as opposed to a directory that could not be read at all. */
function isAbsent(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Whether `p` is a directory: true, false (positively absent), or undefined (unreadable). */
async function isDir(p: string): Promise<boolean | undefined> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch (e) {
    return isAbsent(e) ? false : undefined;
  }
}

/**
 * Why `k` can no longer be resumed, or undefined when it can be OR the
 * evidence does not say. Only a positive finding retires an entry; losing a
 * resumable session costs more than carrying a spent row.
 *
 * - An entry with no recorded folder is kept: Change Folder… repairs it.
 * - A missing folder counts only when its parent is present. A network mount
 *   that is down usually leaves an empty mountpoint, where every path below
 *   reads as ENOENT; requiring the parent keeps that outage from erasing
 *   every entry on the mount.
 * - A folder with any transcript is kept even when this conversation's is
 *   gone, since Resume continues the name's newest one, not this id.
 */
export async function unresumable(k: KnownSession, projectDirs: string[]): Promise<Unresumable | undefined> {
  if (!k.cwd) {
    return undefined;
  }
  const here = await isDir(k.cwd);
  if (here === undefined) {
    return undefined;
  }
  if (!here) {
    return (await isDir(path.dirname(k.cwd))) === true ? "folder-gone" : undefined;
  }
  const slug = projectSlug(k.cwd);
  let folderSeen = false;
  for (const dir of projectDirs) {
    let entries: string[];
    try {
      entries = await fsp.readdir(path.join(dir, slug));
    } catch (e) {
      if (isAbsent(e)) {
        continue;
      }
      return undefined; // unreadable: no finding either way
    }
    folderSeen = true;
    if (entries.some((f) => f.endsWith(".jsonl"))) {
      return undefined;
    }
  }
  // No transcript dir for this folder anywhere: transcripts may simply not be
  // where this looks, which is not evidence that there is nothing to resume.
  return folderSeen ? "no-transcript" : undefined;
}
