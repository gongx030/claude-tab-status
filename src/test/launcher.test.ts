import { test } from "node:test";
import * as assert from "node:assert/strict";
import { backendOfLauncher, invalidSessionName, launchCommand, parseTargets, uniqueSessionName } from "../launcher";

test("backends parse from --list --json or --list lines, and map from a CC_BACKEND record", () => {
  const lines = parseTargets("claude\tAnthropic (primary)\nclaude-build\tRoche AI Gateway\n\n");
  assert.deepEqual(lines, [
    { name: "claude", description: "Anthropic (primary)" },
    { name: "claude-build", description: "Roche AI Gateway" },
  ]);
  assert.deepEqual(parseTargets(JSON.stringify([{ name: "claude", description: "Anthropic (primary)" }, "claude-zai"])), [
    { name: "claude", description: "Anthropic (primary)" },
    { name: "claude-zai", description: "" },
  ]);
  assert.equal(backendOfLauncher("claude_build"), "claude-build");
  assert.equal(backendOfLauncher("claude"), "claude");
});

test("a new session gets a free tmux-safe name and a launcher command that holds a failure open", () => {
  const taken = new Set(["slurm-tools", "slurm-tools2"]);
  assert.equal(uniqueSessionName("slurm-tools", taken), "slurm-tools3");
  assert.equal(uniqueSessionName("my.repo", taken), "my-repo");
  assert.equal(invalidSessionName("a:b"), "Use letters, digits, '-' and '_' only.");
  assert.equal(invalidSessionName("autodev2"), undefined);
  assert.equal(
    launchCommand("/bin/ual", "claude-build", "it's", "/p/x", ["-r", "u-1"]),
    `'/bin/ual' 'claude-build' '--session' 'it'\\''s' '--cwd' '/p/x' '-r' 'u-1'` +
      ` || { rc=$?; echo; read -rp "exited $rc; Enter to close " _; }`,
  );
});
