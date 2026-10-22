import { promises as fsp } from "fs";
import * as path from "path";
import { KnownSession } from "./sessionList";

/** "Not there", as opposed to a path that could not be read at all. */
function isAbsent(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The device `p` is on; null when `p` is positively absent, undefined when it cannot be read. */
export async function deviceOf(p: string): Promise<number | null | undefined> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory() ? st.dev : null;
  } catch (e) {
    return isAbsent(e) ? null : undefined;
  }
}

/**
 * Whether `k`'s folder has been deleted, so that Resume can no longer reopen
 * it. Resume continues the name's newest conversation in the folder, else
 * starts a new one, so while the folder exists Resume always works; only a
 * deleted folder makes the entry spent.
 *
 * "Deleted" is told apart from "unreachable" by device, not by path: the
 * folder is missing AND its nearest existing ancestor is on the device the
 * folder was recorded on (`cwdDev`), so that filesystem is mounted and the
 * folder is not on it. A network mount that is down leaves an empty
 * mountpoint on the device BELOW it, at any depth, and so keeps the entry.
 * An entry with no recorded folder or device, or any unreadable path, is
 * kept: losing a resumable session costs more than carrying a spent row.
 */
export async function folderDeleted(k: KnownSession): Promise<boolean> {
  if (!k.cwd || k.cwdDev === undefined) {
    return false;
  }
  if ((await deviceOf(k.cwd)) !== null) {
    return false; // present, or unreadable
  }
  for (let dir = path.dirname(k.cwd); ; dir = path.dirname(dir)) {
    const dev = await deviceOf(dir);
    if (dev === undefined) {
      return false;
    }
    if (dev !== null) {
      return dev === k.cwdDev;
    }
    if (dir === path.dirname(dir)) {
      return false;
    }
  }
}
