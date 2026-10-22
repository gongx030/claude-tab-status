import { test } from "node:test";
import * as assert from "node:assert/strict";
import { configDirOfEnviron } from "../claudeSessions";
import { launcherOfConfigDir } from "../launcher";
import { backendLabel, buildRows, paneOf, rememberRows, stoppedSessions, withFolder } from "../sessionList";
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
  assert.equal(backendLabel(undefined), "unrecorded");

  // An unrecorded session's launcher, from its Claude process's config dir.
  assert.equal(configDirOfEnviron("HOME=/h\0CLAUDE_CONFIG_DIR=/h/.claude-build\0", "/x"), "/h/.claude-build");
  assert.equal(configDirOfEnviron("HOME=/h\0", "/x"), "/h/.claude");
  assert.equal(launcherOfConfigDir("/h/.claude-build"), "claude_build");
  assert.equal(launcherOfConfigDir("/h/.claude"), "claude");
  assert.equal(launcherOfConfigDir("/opt/cc-config"), undefined);
});

test("rows list every tmux session running Claude, recorded or not, with the VS Code tabs attached to each", () => {
  // tmux server 50 -> pane 52 ($1) -> claude 51; pane 54 ($2) -> claude 53; pane 56 ($3) -> claude 55
  // pane 58 ($4) -> claude 57. VS Code shell 60 -> tmux client 61 ($1); terminal 70 IS a tmux client ($1): a duplicate
  // $2 is detached; $3 and $4 have no CC_BACKEND record (`tmux new` by hand), and only $3's launcher can be inferred
  const e = new Date(T0).toString().slice(0, 24);
  const procs = parsePs(
    [`50 1 ? ${e}`, `52 50 pts/9 ${e}`, `51 52 pts/9 ${e}`, `54 50 pts/8 ${e}`, `53 54 pts/8 ${e}`,
     `56 50 pts/7 ${e}`, `55 56 pts/7 ${e}`, `58 50 pts/6 ${e}`, `57 58 pts/6 ${e}`, `10 1 ? ${e}`,
     `60 10 pts/4 ${e}`, `61 60 pts/4 ${e}`, `70 10 pts/5 ${e}`].join("\n"),
  );
  const tmux = parseTmuxSnapshot(
    "52 $1\n54 $2\n56 $3\n58 $4\n", "61 $1 100\n70 $1 90\n", "$1\tvcc\n$2\tautodev\n$3\tmanual\n$4\tbare\n",
  );
  const launchers = new Map([["$1", "claude_build"], ["$2", "claude"]]);

  const rows = buildRows(
    [session(51, "vcc-chat"), session(53, "autodev"), session(55, "manual"), session(57, "bare")],
    procs, tmux, launchers, new Set([60, 70]), new Map([[55, "claude_codex"]]),
  );

  assert.deepEqual(
    rows.map((r) => [r.tmuxName, r.session.name, r.launcher, r.unrecorded, r.terminals]),
    [
      ["autodev", "autodev", "claude", false, []],
      ["bare", "bare", undefined, true, []],
      ["manual", "manual", "claude_codex", true, []],
      ["vcc", "vcc-chat", "claude_build", false, [60, 70]],
    ],
  );
  // Remembered with its inferred launcher, which Resume uses; an unknown one keeps the last known.
  const known = rememberRows([{ host: "h", tmuxName: "bare", launcher: "claude", name: "bare", sessionId: "x", lastSeen: 1 }], rows, "h", 2);
  assert.deepEqual(known.map((k) => [k.tmuxName, k.launcher]), [["autodev", "claude"], ["bare", "claude"], ["manual", "claude_codex"], ["vcc", "claude_build"]]);
});

test("a remembered session whose tmux session ended is stopped", () => {
  const e = new Date(T0).toString().slice(0, 24);
  const procs = parsePs([`50 1 ? ${e}`, `52 50 pts/9 ${e}`, `51 52 pts/9 ${e}`].join("\n"));
  const tmux = parseTmuxSnapshot("52 $1\n", "", "$1\tvcc\n");
  const rows = buildRows([session(51, "vcc")], procs, tmux, new Map([["$1", "claude_build"]]), new Set());
  const base = { launcher: "claude", sessionId: "u-2", cwd: "/p/autodev", lastSeen: 1 };
  const earlier = [
    { ...base, tmuxName: "autodev2", name: "autodev2", host: "h1" },
    { ...base, tmuxName: "ad_map", name: "ad_map", host: "h2" }, // another host's: never stopped here
  ];

  const known = rememberRows(earlier, rows, "h1", 99);
  assert.deepEqual(
    known.map((k) => [k.tmuxName, k.host, k.launcher, k.lastSeen]),
    [["ad_map", "h2", "claude", 1], ["autodev2", "h1", "claude", 1], ["vcc", "h1", "claude_build", 99]],
  );
  assert.deepEqual(stoppedSessions(known, tmux, "h1", rows).map((k) => k.tmuxName), ["autodev2"]);
  // A conversation running under another tmux name is not also listed as stopped:
  // matched by id, or by name in the same folder (a relaunch can fork a new id).
  const live = rows.map((r) => ({ ...r, session: { ...r.session, cwd: "/p/vcc" } }));
  const elsewhere = [
    ...known,
    { ...base, tmuxName: "vcc-old", name: "vcc", sessionId: "vcc", host: "h1" },
    { ...base, tmuxName: "vcc-older", name: "vcc", sessionId: "vcc-prev", cwd: "/p/vcc", host: "h1" },
    { ...base, tmuxName: "vcc-nocwd", name: "vcc", sessionId: "vcc-x", cwd: undefined, host: "h1" },
  ];
  assert.deepEqual(stoppedSessions(elsewhere, tmux, "h1", live).map((k) => k.tmuxName), ["autodev2", "vcc-nocwd"]);

  // Change Folder edits only that host's entry, and reports a forgotten one.
  const twin = [...earlier, { ...base, tmuxName: "autodev2", name: "autodev2", host: "h2" }];
  const moved = withFolder(twin, "h1", "autodev2", "/p/new")!;
  assert.deepEqual(moved.map((k) => k.cwd), ["/p/new", "/p/autodev", "/p/autodev"]);
  assert.equal(withFolder(earlier, "h1", "ad_map", "/p/new"), undefined);

  assert.equal(paneOf(51, "52 %7\n60 %8\n", procs), "%7");
});
