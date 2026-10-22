import { promises as fsp } from "fs";

/**
 * Whether `cwd` is positively absent. A folder on a mount that is down reads
 * as absent too, which is why this only MARKS a Stopped row and never removes
 * one: Change Folder… can still point it at a replacement, and the folder may
 * come back. Any other error (permission, I/O) is not evidence and reads false.
 */
export async function folderMissing(cwd: string): Promise<boolean> {
  try {
    return !(await fsp.stat(cwd)).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}
