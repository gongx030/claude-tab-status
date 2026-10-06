import * as fs from "fs";

/**
 * Set a terminal's title by writing an OSC 2 sequence to its tty.
 *
 * VS Code has no API to rename a terminal the extension did not create
 * (`Terminal.name` is read-only and `renameWithArg` acts only on the active
 * terminal), so the title is set the way any program in the terminal would.
 * This touches no focus, tab or group. One small write() is not interleaved
 * with output from the program in the foreground.
 */
export function writeTitle(tty: string, title: string): void {
  if (!/^\/dev\/(pts\/\d+|ttys\d+)$/.test(tty)) {
    throw new Error(`refusing to write to non-terminal path ${tty}`);
  }
  // VS Code shows a process-set title on the tab (by default) only once the
  // terminal is classified as an agent CLI, which happens when a title matches
  // /claude\s*code/i (terminalInstance.ts `agentCliTitlePatterns`); the
  // classification then sticks until a real shell takes over. Prime it in the
  // same write. An empty title is a reset and needs no priming.
  const seq = title ? `\x1b]2;Claude Code\x07\x1b]2;${title}\x07` : `\x1b]2;\x07`;
  // NONBLOCK: a terminal paused by flow control must not stall the extension host.
  const fd = fs.openSync(tty, fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
  try {
    fs.writeSync(fd, seq);
  } finally {
    fs.closeSync(fd);
  }
}
