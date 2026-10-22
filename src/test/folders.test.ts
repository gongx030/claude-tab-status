import { test } from "node:test";
import * as assert from "node:assert/strict";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { folderMissing, folderMissingWithin } from "../folders";
import { stoppedDescription } from "../sessionList";

test("a Stopped row names its tmux session when it differs, and marks a missing folder", () => {
  const k = { name: "vcc", sessionId: "u-1", host: "h1", lastSeen: 0, launcher: "claude_build" };
  assert.equal(stoppedDescription({ ...k, tmuxName: "vcc" }, false), "build");
  assert.equal(stoppedDescription({ ...k, tmuxName: "vcc2" }, false), "build · vcc2");
  // tmux spells "." and ":" as "_": not a difference worth naming.
  assert.equal(stoppedDescription({ ...k, name: "v1.2", tmuxName: "v1_2" }, false), "build");
  assert.equal(stoppedDescription({ ...k, tmuxName: "vcc2" }, true), "build · vcc2 · folder missing");
});

test("a folder is missing only when its path is positively absent", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "folders-"));
  try {
    assert.equal(await folderMissing(root), false);
    assert.equal(await folderMissing(path.join(root, "removed-worktree")), true);
    await fsp.writeFile(path.join(root, "file"), "");
    assert.equal(await folderMissing(path.join(root, "file")), true); // not a directory
    assert.equal(await folderMissingWithin(path.join(root, "removed-worktree"), 5_000), true);
    // A check still in flight is not started twice: the second call answers "no evidence" at once.
    const first = folderMissingWithin(root, 5_000);
    assert.equal(await folderMissingWithin(root, 5_000), undefined);
    assert.equal(await first, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
