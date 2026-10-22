import { promises as fsp } from "fs";

/**
 * Whether `cwd` is positively absent (ENOENT/ENOTDIR, or not a directory):
 * a deleted folder, or an automount point whose mount is gone. Any other
 * error (permission, EIO, ESTALE) is not evidence and reads false. This only
 * MARKS a Stopped row, never removes one: Change Folder… can still point it
 * at a replacement, and the folder may come back.
 */
export async function folderMissing(cwd: string): Promise<boolean> {
  try {
    return !(await fsp.stat(cwd)).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/** Folders whose stat has not returned yet; not stat'ed again until it does. */
const pending = new Set<string>();

/**
 * `folderMissing`, or undefined when it has not answered within `ms`. A stat
 * on a hung mount never returns and pins a thread of the extension host's
 * shared libuv pool, so a folder still pending from an earlier call is
 * answered undefined at once instead of pinning another.
 */
export function folderMissingWithin(cwd: string, ms: number): Promise<boolean | undefined> {
  if (pending.has(cwd)) {
    return Promise.resolve(undefined);
  }
  pending.add(cwd);
  const check = folderMissing(cwd).finally(() => pending.delete(cwd));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([check, timeout]).finally(() => clearTimeout(timer));
}
