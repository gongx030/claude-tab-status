import { test } from "node:test";
import * as assert from "node:assert/strict";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { folderMissing } from "../folders";
import { stoppedDescription } from "../sessionList";

test("a Stopped row names its tmux session when it differs, and marks a missing folder", async () => {
  const k = { name: "vcc", sessionId: "u-1", host: "h1", lastSeen: 0, launcher: "claude_build" };
  assert.equal(stoppedDescription({ ...k, tmuxName: "vcc" }, false), "build");
  assert.equal(stoppedDescription({ ...k, tmuxName: "vcc2" }, false), "build · vcc2");
  // tmux spells "." and ":" as "_": not a difference worth naming.
  assert.equal(stoppedDescription({ ...k, name: "v1.2", tmuxName: "v1_2" }, false), "build");
  assert.equal(stoppedDescription({ ...k, tmuxName: "vcc2" }, true), "build · vcc2 · folder missing");

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resumable-"));
  assert.equal(await folderMissing(root), false);
  assert.equal(await folderMissing(path.join(root, "removed-worktree")), true);
  await fsp.writeFile(path.join(root, "file"), "");
  assert.equal(await folderMissing(path.join(root, "file")), true); // not a directory
  await fsp.rm(root, { recursive: true, force: true });
});
