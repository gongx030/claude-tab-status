import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseSessionFile } from "../claudeSessions";
import { formatTerminalTitle, resolveSessionName } from "../titleFormatter";

const noLog = () => {};
const base = { pid: 7, sessionId: "abc12345-x", kind: "interactive", name: "VCC-transfer", startedAt: 1 };

test("session file -> title for every Claude Code status", () => {
  const cases: [string, string][] = [
    ["busy", "VCC-transfer ●"],
    ["waiting", "VCC-transfer ?"],
    ["idle", "VCC-transfer ○"],
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
