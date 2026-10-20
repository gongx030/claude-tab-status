import { test } from "node:test";
import * as assert from "node:assert/strict";
import { backendLabel, buildRows, paneOf, rememberRows, resumeCommand, stoppedSessions } from "../sessionList";
import { parsePs } from "../terminalTracker";
import { parseBackendRecord, parseTmuxSnapshot } from "../tmuxClients";
import { ClaudeSessionState } from "../titleFormatter";

const T0 = Date.parse("Tue Oct  6 09:00:00 2026");

function session(pid: number, name: string): ClaudeSessionState {
  return { pid, sessionId: name, name, status: "idle", startedAt: T0 + 5000, updatedAt: 0 };
}

test("tmux output parses into panes, clients, session names and backend records", () => {
  const snap = parseTmuxSnapshot("52 $1\n54 $2\n", "61 $1 100\n", "$1\tdisease map\n$2\tvcc\n");
  assert.deepEqual([...snap.panes], [[52, "$1"], [54, "$2"]]);
  assert.deepEqual(snap.clients, [{ pid: 61, sessionId: "$1" }]);
  assert.equal(snap.sessions.get("$1"), "disease map");
  assert.deepEqual([...snap.hops], [[52, [61]]]);

  assert.equal(parseBackendRecord("CC_BACKEND=claude_build\n"), "claude_build");
  assert.equal(parseBackendRecord("-CC_BACKEND\n"), undefined); // removed with set-environment -r
  assert.equal(backendLabel("claude_build"), "build");
  assert.equal(backendLabel("claude"), "claude");
});

test("rows list recorded tmux sessions with the VS Code tabs attached to each", () => {
  // tmux server 50 -> pane 52 ($1) -> claude 51; pane 54 ($2) -> claude 53; pane 56 ($3) -> claude 55
  // VS Code shell 60 -> tmux client 61 ($1); terminal 70 IS a tmux client ($1): a duplicate
  // $2 is detached; $3 has no CC_BACKEND record
  const e = new Date(T0).toString().slice(0, 24);
  const procs = parsePs(
    [`50 1 ? ${e}`, `52 50 pts/9 ${e}`, `51 52 pts/9 ${e}`, `54 50 pts/8 ${e}`, `53 54 pts/8 ${e}`,
     `56 50 pts/7 ${e}`, `55 56 pts/7 ${e}`, `10 1 ? ${e}`, `60 10 pts/4 ${e}`, `61 60 pts/4 ${e}`,
     `70 10 pts/5 ${e}`].join("\n"),
  );
  const tmux = parseTmuxSnapshot("52 $1\n54 $2\n56 $3\n", "61 $1 100\n70 $1 90\n", "$1\tvcc\n$2\tautodev\n$3\tmanual\n");
  const launchers = new Map([["$1", "claude_build"], ["$2", "claude"]]);

  const rows = buildRows(
    [session(51, "vcc-chat"), session(53, "autodev"), session(55, "manual")],
    procs, tmux, launchers, new Set([60, 70]),
  );

  assert.deepEqual(
    rows.map((r) => [r.tmuxName, r.session.name, r.launcher, r.terminals]),
    [["autodev", "autodev", "claude", []], ["vcc", "vcc-chat", "claude_build", [60, 70]]],
  );
});

test("a remembered session whose tmux session ended is stopped, and resumes through its wrapper", () => {
  const e = new Date(T0).toString().slice(0, 24);
  const procs = parsePs([`50 1 ? ${e}`, `52 50 pts/9 ${e}`, `51 52 pts/9 ${e}`].join("\n"));
  const tmux = parseTmuxSnapshot("52 $1\n", "", "$1\tvcc\n");
  const rows = buildRows([session(51, "vcc")], procs, tmux, new Map([["$1", "claude_build"]]), new Set());
  const earlier = [{ tmuxName: "autodev2", launcher: "claude", name: "autodev2", sessionId: "u-2", cwd: "/p/autodev", lastSeen: 1 }];

  const known = rememberRows(earlier, rows, 99);
  assert.deepEqual(known.map((k) => [k.tmuxName, k.launcher, k.lastSeen]), [["autodev2", "claude", 1], ["vcc", "claude_build", 99]]);
  assert.deepEqual(stoppedSessions(known, tmux).map((k) => k.tmuxName), ["autodev2"]);

  assert.equal(paneOf(51, "52 %7\n60 %8\n", procs), "%7");
  assert.equal(
    resumeCommand(known[0], "claude_codex"),
    `if declare -F 'autodev2' >/dev/null; then 'autodev2' 'codex'; else cd '/p/autodev' && 'claude_codex' -r 'u-2'; fi` +
      ` || { rc=$?; echo; read -rp "exited $rc; Enter to close " _; }`,
  );
});
