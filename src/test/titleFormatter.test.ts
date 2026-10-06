import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseSessionFile } from "../claudeSessions";
import { formatTerminalTitle, resolveSessionName } from "../titleFormatter";

const noLog = () => {};

test("session file -> title for every Claude Code status", () => {
  const cases: [string, string][] = [
    ["busy", "VCC-transfer ●"],
    ["waiting", "VCC-transfer ?"],
    ["idle", "VCC-transfer ○"],
    ["shell", "VCC-transfer ○"],
  ];
  for (const [status, title] of cases) {
    const text = JSON.stringify({ pid: 7, sessionId: "abc12345-x", kind: "interactive", name: "VCC-transfer", status });
    const parsed = parseSessionFile(text, "7.json", noLog);
    assert.ok(parsed, status);
    assert.equal(formatTerminalTitle(parsed.state), title);
  }
});

test("files that must not bind are rejected", () => {
  const base = { pid: 7, sessionId: "abc", name: "n", status: "idle" };
  assert.equal(parseSessionFile("{not json", "7.json", noLog), undefined);
  assert.equal(parseSessionFile(JSON.stringify({ ...base, kind: "bg" }), "7.json", noLog), undefined);
  assert.equal(parseSessionFile(JSON.stringify({ ...base, status: "sleeping" }), "7.json", noLog), undefined);
  assert.equal(parseSessionFile(JSON.stringify({ ...base, pid: "7" }), "7.json", noLog), undefined);
});

test("name falls back to short id and never carries control characters", () => {
  assert.equal(resolveSessionName({ name: undefined, sessionId: "53a4a993-656f" }), "53a4a993");
  assert.equal(resolveSessionName({ name: "  ", sessionId: "53a4a993-656f" }), "53a4a993");
  assert.equal(resolveSessionName({ name: "evil\x1b]2;x\x07name", sessionId: "s" }), "evil]2;xname");
});
