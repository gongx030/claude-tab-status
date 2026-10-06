import { test } from "node:test";
import * as assert from "node:assert/strict";
import { StatusStore } from "../statusStore";
import { ClaudeSessionState } from "../titleFormatter";

function session(sessionId: string): ClaudeSessionState {
  return { pid: 1, sessionId, name: sessionId, status: "idle", startedAt: 0, updatedAt: 0 };
}

test("writes on change (all on re-assert), retries failures, resets only a tty its shell still owns", () => {
  const writes: [string, string][] = [];
  let failNext = false;
  const store = new StatusStore((tty, title) => {
    if (failNext) {
      failNext = false;
      throw new Error("EAGAIN");
    }
    writes.push([tty, title]);
  }, () => {});
  const a = { shellPid: 20, tty: "/dev/pts/1", session: session("A") };
  const b = { shellPid: 30, tty: "/dev/pts/2", session: session("B") };
  const ttys = new Map([[20, "/dev/pts/1"], [30, "/dev/pts/2"]]);

  failNext = true;
  store.update([a, b], ttys); // A fails, B written
  store.update([a, b], ttys); // A retried, B unchanged
  assert.deepEqual(writes, [["/dev/pts/2", "B 🟢"], ["/dev/pts/1", "A 🟢"]]);

  // A re-assert pass rewrites unchanged titles (Claude Code may have overwritten them).
  writes.length = 0;
  store.update([a, b], ttys, new Set(), true);
  assert.deepEqual(writes, [["/dev/pts/1", "A 🟢"], ["/dev/pts/2", "B 🟢"]]);

  // A failed re-assert (backed-up tty) backs off: the next pass skips that tty.
  writes.length = 0;
  failNext = true;
  store.update([a, b], ttys, new Set(), true); // A fails, B written
  store.update([a, b], ttys, new Set(), true); // A skipped, B written
  assert.deepEqual(writes, [["/dev/pts/2", "B 🟢"], ["/dev/pts/2", "B 🟢"]]);

  // Claude in shell 20 exits (shell alive): reset. Terminal 30 closes and a new
  // shell 31 reuses /dev/pts/2: its title must not be overwritten by a reset.
  writes.length = 0;
  const c = { shellPid: 31, tty: "/dev/pts/2", session: session("C") };
  store.update([c], new Map([[20, "/dev/pts/1"], [31, "/dev/pts/2"]]));
  assert.deepEqual(writes, [["/dev/pts/2", "C 🟢"], ["/dev/pts/1", ""]]);
});
