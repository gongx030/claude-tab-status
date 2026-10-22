import { promises as fsp } from "fs";
import * as path from "path";
import { KnownSession } from "./sessionList";

/**
 * Why a remembered session can no longer be resumed. Resume relaunches the
 * newest conversation of its NAME in its FOLDER, so an entry is spent once
 * that folder is gone or holds no transcript of the conversation it stands
 * for: clicking Resume would silently start a new conversation instead.
 */
export type Unresumable = "no-folder" | "folder-gone" | "no-transcript";

export const UNRESUMABLE_REASON: Record<Unresumable, string> = {
  "no-folder": "no folder was ever recorded for it",
  "folder-gone": "its folder no longer exists",
  "no-transcript": "its conversation is no longer on disk",
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

/**
 * Why `k` can no longer be resumed, or undefined when it can be OR the
 * evidence does not say. Only a positive finding retires an entry: a mount
 * that is down, a home that cannot be listed, or a transcript filed under a
 * slug this does not predict all leave the entry in place, because losing a
 * resumable session costs more than carrying a spent row.
 */
export async function unresumable(k: KnownSession, projectDirs: string[]): Promise<Unresumable | undefined> {
  if (!k.cwd) {
    return "no-folder"; // Resume refuses it outright; see resumeSession.
  }
  try {
    if (!(await fsp.stat(k.cwd)).isDirectory()) {
      return "folder-gone";
    }
  } catch (e) {
    return isAbsent(e) ? "folder-gone" : undefined;
  }
  const slug = projectSlug(k.cwd);
  let folderSeen = false;
  for (const dir of projectDirs) {
    try {
      await fsp.stat(path.join(dir, slug, `${k.sessionId}.jsonl`));
      return undefined;
    } catch (e) {
      if (!isAbsent(e)) {
        return undefined; // unreadable: no finding either way
      }
    }
    try {
      await fsp.stat(path.join(dir, slug));
      folderSeen = true;
    } catch (e) {
      if (!isAbsent(e)) {
        return undefined;
      }
    }
  }
  // No transcript dir for this folder anywhere: transcripts may simply not be
  // where this looks, which is not evidence that the conversation is gone.
  return folderSeen ? "no-transcript" : undefined;
}
