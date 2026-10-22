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
  const slugDir = path.join(projects, projectSlug(cwd));
  await fsp.mkdir(cwd);
  await fsp.mkdir(slugDir, { recursive: true });

  assert.equal(projectSlug("/cv/x/disease_map/.claude/worktrees/w"), "-cv-x-disease-map--claude-worktrees-w");

  // The folder holds no conversation at all: Resume could only start a new one.
  assert.equal(await unresumable(KNOWN(cwd), [projects]), "no-transcript");
  // Another conversation is there: Resume continues the name's newest, so this
  // id's transcript being gone proves nothing.
  await fsp.writeFile(path.join(slugDir, "other.jsonl"), "");
  assert.equal(await unresumable(KNOWN(cwd), [projects]), undefined);
  // No transcript directory for the folder anywhere: no evidence, so it stays.
  assert.equal(await unresumable(KNOWN(cwd), [path.join(root, "nowhere")]), undefined);
  // A deleted worktree (parent present) is gone; a path whose parent is also
  // absent, as under a mount that is down, is not evidence.
  assert.equal(await unresumable(KNOWN(path.join(root, "removed-worktree")), [projects]), "folder-gone");
  assert.equal(await unresumable(KNOWN(path.join(root, "unmounted", "repo")), [projects]), undefined);
  // No recorded folder: kept, since Change Folder… repairs it.
  assert.equal(await unresumable(KNOWN(undefined), [projects]), undefined);

  await fsp.rm(root, { recursive: true, force: true });
});
