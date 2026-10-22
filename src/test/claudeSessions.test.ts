import { test } from "node:test";
import * as assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { parseSessionFile, readSessions } from "../claudeSessions";
import { formatTerminalTitle, resolveSessionName } from "../titleFormatter";

const noLog = () => {};
const base = { pid: 7, sessionId: "abc12345-x", kind: "interactive", name: "VCC-transfer", startedAt: 1 };

test("session file -> title for every Claude Code status", () => {
  const cases: [string, string][] = [
    ["busy", "VCC-transfer ●"],
    ["waiting", "VCC-transfer 🟠"],
    ["idle", "VCC-transfer 🟢"],
    ["shell", "VCC-transfer ●"],
  ];
  for (const [status, title] of cases) {
    const s = parseSessionFile(JSON.stringify({ ...base, status }), "7.json", noLog);
    assert.ok(s?.status, status);
    assert.equal(formatTerminalTitle({ ...s, status: s.status }), title);
  }
  // Unknown status: still a session (so the title is held), but no status to render.
  assert.equal(parseSessionFile(JSON.stringify({ ...base, status: "compacting" }), "7.json", noLog)?.status, undefined);
});

test("files that must not bind are rejected; invalid JSON throws so the title is held", () => {
  assert.throws(() => parseSessionFile("{not json", "7.json", noLog));
  for (const bad of [{ kind: "bg" }, { kind: "tui" }, { pid: "7" }, { startedAt: undefined }]) {
    assert.equal(parseSessionFile(JSON.stringify({ ...base, status: "idle", ...bad }), "7.json", noLog), undefined);
  }
});

test("name falls back to short id and never carries control characters", () => {
  assert.equal(resolveSessionName({ name: undefined, sessionId: "53a4a993-656f" }), "53a4a993");
  assert.equal(resolveSessionName({ name: "  ", sessionId: "53a4a993-656f" }), "53a4a993");
  assert.equal(resolveSessionName({ name: "evil\x1b]2;x\x07name", sessionId: "s" }), "evil]2;xname");
  assert.equal(resolveSessionName({ name: "", sessionId: "\x07\x1b]0;xyz-123456" }), "]0;xyz-1");
});

test("a session file caught mid-write, or a dir that cannot be listed, keeps the previous scan's session", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cts-sessions-"));
  try {
    writeFileSync(path.join(dir, "7.json"), JSON.stringify({ ...base, status: "idle" }));
    const first = await readSessions([dir], noLog);
    writeFileSync(path.join(dir, "7.json"), '{"pid": 7, "sess');
    const midWrite = await readSessions([dir], noLog, first);
    assert.equal(midWrite.sessions.get(7)?.name, "VCC-transfer");
    assert.deepEqual([...midWrite.unreadable], [7]);
    // Held for one poll only, and without a previous read there is nothing to hold.
    assert.equal((await readSessions([dir], noLog, midWrite)).sessions.size, 0);
    assert.equal((await readSessions([dir], noLog)).sessions.size, 0);

    // root lists a mode-000 dir anyway.
    if (process.getuid?.() !== 0) {
      chmodSync(dir, 0o000);
      const unlisted = await readSessions([dir], noLog, first);
      chmodSync(dir, 0o700);
      assert.equal(unlisted.sessions.get(7)?.name, "VCC-transfer");
    }
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
