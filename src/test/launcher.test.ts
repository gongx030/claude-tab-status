import { test } from "node:test";
import * as assert from "node:assert/strict";
import { invalidSessionName, launchCommand, parseTargets, uniqueSessionName } from "../launcher";

test("backends parse from --list --json, else from --list lines", () => {
  // Captured from unified-agent-launch --list --json (feat/launch-named-session) and --list.
  const json = '[{"backend": "claude", "label": "Anthropic (primary)", "launcher": "claude"}, ' +
    '{"backend": "claude-build", "label": "Roche AI Gateway", "launcher": "claude_build"}]';
  const expected = [
    { name: "claude", description: "Anthropic (primary)", launcher: "claude" },
    { name: "claude-build", description: "Roche AI Gateway", launcher: "claude_build" },
  ];
  assert.deepEqual(parseTargets(json), expected);
  assert.deepEqual(parseTargets("claude\tAnthropic (primary)\nclaude-build\tRoche AI Gateway\n\n"), expected);
});

test("a new session gets a free tmux-safe name and a launcher command that holds a failure open", () => {
  const taken = new Set(["slurm-tools", "slurm-tools2"]);
  assert.equal(uniqueSessionName("slurm-tools", taken), "slurm-tools3");
  assert.equal(uniqueSessionName("my.repo", taken), "my-repo");
  assert.equal(invalidSessionName("a:b"), "Use letters, digits, '-' and '_' only.");
  assert.equal(invalidSessionName("autodev2"), undefined);
  assert.equal(
    launchCommand("/bin/ual", "claude-build", "it's", "/p/x"),
    `'/bin/ual' 'claude-build' '--session' 'it'\\''s' '--cwd' '/p/x'` +
      ` || { rc=$?; echo; read -rp "exited $rc; Enter to close " _; }`,
  );
});
