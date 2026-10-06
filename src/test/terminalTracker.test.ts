import { test } from "node:test";
import * as assert from "node:assert/strict";
import { bindTerminals, parsePs } from "../terminalTracker";
import { ClaudeSessionState } from "../titleFormatter";

function session(pid: number, sessionId: string, updatedAt = 0): ClaudeSessionState {
  return { pid, sessionId, name: sessionId, status: "idle", updatedAt };
}

test("parsePs reads Linux and macOS tty columns", () => {
  const procs = parsePs("  100     1 ?\n  200   100 pts/3\n  300   200 ttys003\n");
  assert.deepEqual(procs.get(100), { ppid: 1, tty: undefined });
  assert.deepEqual(procs.get(200), { ppid: 100, tty: "/dev/pts/3" });
  assert.deepEqual(procs.get(300), { ppid: 200, tty: "/dev/ttys003" });
});

test("each session binds to its nearest terminal shell only", () => {
  // ptyhost 10 -> shell A 20 -> bash 21 -> claude 22   (nested shell)
  // ptyhost 10 -> shell B 30 -> claude 31 -> bash 32 -> claude 33 (claude inside claude)
  // ptyhost 10 -> shell C 40 (plain shell)
  // tmux 50 -> claude 51 (not under any terminal shell)
  const procs = parsePs(
    ["10 1 ?", "20 10 pts/1", "21 20 pts/1", "22 21 pts/1", "30 10 pts/2", "31 30 pts/2",
     "32 31 pts/2", "33 32 pts/2", "40 10 pts/3", "50 1 ?", "51 50 pts/9"].join("\n"),
  );
  const sessions = new Map([
    [22, session(22, "A")],
    [31, session(31, "outer", 999)],
    [33, session(33, "inner", 1)],
    [51, session(51, "tmux")],
    [77, session(77, "dead")], // stale file: pid not in the process table
  ]);
  const bound = bindTerminals([20, 30, 40], sessions, procs);
  assert.deepEqual(
    [...bound].map(([shell, s]) => [shell, s.sessionId]).sort(),
    [[20, "A"], [30, "inner"]],
  );
});
