import { test } from "node:test";
import * as assert from "node:assert/strict";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { KnownSession } from "../sessionList";
import { folderDeleted } from "../resumable";

const KNOWN = (cwd: string | undefined, cwdDev: number | undefined): KnownSession => ({
  tmuxName: "vcc",
  name: "vcc",
  sessionId: "abc",
  cwd,
  cwdDev,
  host: "h1",
  lastSeen: 0,
});

test("a stopped session's folder counts as deleted only when its own filesystem is still mounted", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resumable-"));
  const dev = (await fsp.stat(root)).dev;
  const gone = path.join(root, "worktrees", "repo", "removed");
  await fsp.mkdir(path.dirname(gone), { recursive: true });

  // Present: always resumable, whatever was recorded.
  assert.equal(await folderDeleted(KNOWN(root, dev)), false);
  // Missing, and the nearest surviving ancestor is on the recorded device: deleted.
  // That holds at any depth, so a worktree removed with its repo dir is caught too.
  assert.equal(await folderDeleted(KNOWN(gone, dev)), true);
  assert.equal(await folderDeleted(KNOWN(path.join(root, "a", "b", "c"), dev)), true);
  // The surviving ancestor is on another device: the folder's own filesystem is
  // not mounted (an empty mountpoint at any depth), so this is not evidence.
  assert.equal(await folderDeleted(KNOWN(gone, dev + 1)), false);
  // Nothing recorded to compare against, or no folder at all (Change Folder… repairs it): kept.
  assert.equal(await folderDeleted(KNOWN(gone, undefined)), false);
  assert.equal(await folderDeleted(KNOWN(undefined, dev)), false);

  await fsp.rm(root, { recursive: true, force: true });
});
