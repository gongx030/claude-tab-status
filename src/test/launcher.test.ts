import { test } from "node:test";
import * as assert from "node:assert/strict";
import { backendForRecord, invalidSessionName, launchCommand, parseTargets, uniqueSessionName } from "../launcher";

test("backends parse from --list-json, and a CC_BACKEND record maps through launcher or alias", () => {
  // Captured from unified-agent-launch --list-json (unified-agent-sdk f822e99).
  const targets = parseTargets(
    '[{"backend": "claude", "label": "Anthropic (primary)", "launcher": "claude", "aliases": ["claude_max"]}, ' +
      '{"backend": "claude-build", "label": "Roche AI Gateway", "launcher": "claude_build", "aliases": []}]',
  );
  assert.deepEqual(targets[1], {
    name: "claude-build",
    description: "Roche AI Gateway",
    launcher: "claude_build",
    aliases: [],
  });
  assert.equal(backendForRecord(targets, "claude_build"), "claude-build");
  assert.equal(backendForRecord(targets, "claude_max"), "claude");
  assert.equal(backendForRecord(targets, "claude_gone"), undefined);
});

test("a new session gets a name the launcher accepts and a command that holds a failure open", () => {
  const taken = new Set(["slurm-tools", "slurm-tools2"]);
  assert.equal(uniqueSessionName("slurm-tools", taken), "slurm-tools3");
  assert.equal(uniqueSessionName("my.repo", taken), "my-repo");
  for (const bad of ["", "a:b", "a.b", "a b", "-x", "5cda9d32-3daf-406f-a91e-50c01247c36f"]) {
    assert.notEqual(invalidSessionName(bad), undefined, bad);
  }
  assert.equal(invalidSessionName("autodev2"), undefined);
  assert.equal(
    launchCommand("/bin/ual", "claude-build", "it's", "/p/x"),
    `'/bin/ual' 'claude-build' '--session' 'it'\\''s' '--cwd' '/p/x' '--detach' ` +
      `&& exec 'tmux' 'attach-session' '-d' '-t' '=it'\\''s' || { rc=$?; echo; ` +
      `if [ $rc -eq 3 ]; then echo "Refused; nothing was started."; else echo "Failed (exit $rc)."; fi; ` +
      `read -rp "Enter to close " _; }`,
  );
});
