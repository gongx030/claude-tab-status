import { test } from "node:test";
import * as assert from "node:assert/strict";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { KnownSession } from "../sessionList";
import { projectSlug, unresumable } from "../resumable";

const KNOWN = (cwd: string | undefined, sessionId = "abc"): KnownSession => ({
  tmuxName: "vcc",
  name: "vcc",
  sessionId,
  cwd,
  host: "h1",
  lastSeen: 0,
});

test("a stopped session is retired only on positive evidence that Resume cannot reopen it", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "resumable-"));
  const cwd = path.join(root, "work_dir");
  const projects = path.join(root, ".claude", "projects");
  await fsp.mkdir(cwd);
  await fsp.mkdir(path.join(projects, projectSlug(cwd)), { recursive: true });

  assert.equal(projectSlug("/cv/x/disease_map/.claude/worktrees/w"), "-cv-x-disease-map--claude-worktrees-w");

  // Its folder is on disk but holds no transcript of this conversation: spent.
  assert.equal(await unresumable(KNOWN(cwd), [projects]), "no-transcript");
  // With the transcript there, it is resumable.
  await fsp.writeFile(path.join(projects, projectSlug(cwd), "abc.jsonl"), "");
  assert.equal(await unresumable(KNOWN(cwd), [projects]), undefined);
  // No transcript directory for the folder anywhere: no evidence, so it stays.
  assert.equal(await unresumable(KNOWN(cwd), [path.join(root, "nowhere")]), undefined);
  // The folder itself is gone, and an entry that never had one.
  assert.equal(await unresumable(KNOWN(path.join(root, "removed-worktree")), [projects]), "folder-gone");
  assert.equal(await unresumable(KNOWN(undefined), [projects]), "no-folder");

  await fsp.rm(root, { recursive: true, force: true });
});
