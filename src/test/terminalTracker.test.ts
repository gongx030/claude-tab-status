import { test } from "node:test";
import * as assert from "node:assert/strict";
import { bindTerminals, parsePs } from "../terminalTracker";
import { parseTmuxHops } from "../tmuxClients";
import { ClaudeSessionState } from "../titleFormatter";

const T0 = Date.parse("Tue Oct  6 09:00:00 2026");

function session(pid: number, sessionId: string, updatedAt = 0): ClaudeSessionState {
  // Claude Code writes startedAt a few seconds after its process starts.
  return { pid, sessionId, name: sessionId, status: "idle", startedAt: T0 + 5000, updatedAt };
}

test("parsePs reads Linux and macOS tty columns and start times", () => {
  const procs = parsePs(
    "  100     1 ?        Tue Oct  6 09:00:00 2026\n  200   100 pts/3    Tue Oct  6 09:00:00 2026\n  300   200 ttys003  Tue Oct  6 09:00:00 2026\n",
  );
  assert.deepEqual(procs.get(100), { ppid: 1, tty: undefined, startMs: T0 });
  assert.deepEqual(procs.get(200), { ppid: 100, tty: "/dev/pts/3", startMs: T0 });
  assert.deepEqual(procs.get(300), { ppid: 200, tty: "/dev/ttys003", startMs: T0 });
});

test("each session binds to its nearest terminal shell only", () => {
  // ptyhost 10 -> shell A 20 -> bash 21 -> claude 22   (nested shell)
  // ptyhost 10 -> shell B 30 -> claude 31 -> bash 32 -> claude 33 (claude inside claude)
  // ptyhost 10 -> shell C 40 -> pid 41: a later process that reused a dead session's pid
  // tmux server 50 -> pane bash 52 -> claude 51; shell D 60 -> tmux client 61
  // tmux server 50 -> pane bash 54 -> claude 53 (detached: no client)
  const at = (t: number) => new Date(t).toString().slice(0, 24);
  const early = at(T0);
  const late = at(T0 + 60_000);
  const procs = parsePs(
    [`10 1 ? ${early}`, `20 10 pts/1 ${early}`, `21 20 pts/1 ${early}`, `22 21 pts/1 ${early}`,
     `30 10 pts/2 ${early}`, `31 30 pts/2 ${early}`, `32 31 pts/2 ${early}`, `33 32 pts/2 ${early}`,
     `40 10 pts/3 ${early}`, `41 40 pts/3 ${late}`, `50 1 ? ${early}`, `52 50 pts/9 ${early}`, `51 52 pts/9 ${early}`,
     `54 50 pts/8 ${early}`, `53 54 pts/8 ${early}`, `60 10 pts/4 ${early}`, `61 60 pts/4 ${early}`].join("\n"),
  );
  const sessions = [
    session(22, "A"),
    session(31, "outer", 999),
    session(33, "inner", 1),
    session(41, "recycled"),
    session(51, "tmux"),
    session(53, "detached"),
    session(77, "dead"), // stale file: pid not in the process table
  ];
  const ids = (b: Map<number, ClaudeSessionState>) => [...b].map(([shell, s]) => [shell, s.sessionId]).sort();
  // Without tmux hops, sessions under the tmux server bind to no terminal.
  assert.deepEqual(ids(bindTerminals([20, 30, 40, 60], sessions, procs)), [[20, "A"], [30, "inner"]]);
  // With them, the attached pane binds to the shell running its client.
  assert.deepEqual(
    ids(bindTerminals([20, 30, 40, 60], sessions, procs, new Map([[52, 61]]))),
    [[20, "A"], [30, "inner"], [60, "tmux"]],
  );
});

test("parseTmuxHops maps each pane to its session's most recently active client", () => {
  const hops = parseTmuxHops(
    "52 $1\n54 $2\n55 $1\n",
    "61 $1 100\n62 $1 200\n",
  );
  assert.deepEqual([...hops].sort(), [[52, 62], [55, 62]]);
});
