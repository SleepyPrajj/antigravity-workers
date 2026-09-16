import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchWorkerTerminal, workerTerminalConfig } from "../server/worker-terminal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const viewer = path.resolve(here, "..", "server", "worker-terminal.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-terminal-test-"));
const stdoutPath = path.join(root, "stdout.log");
const stderrPath = path.join(root, "stderr.log");
const completionPath = path.join(root, "complete.json");

try {
  assert.equal(workerTerminalConfig({}, "linux").enabled, false);
  assert.equal(workerTerminalConfig({ ANTIGRAVITY_WORKER_TERMINALS: "on" }, "linux").enabled, false);
  assert.equal(workerTerminalConfig({ ANTIGRAVITY_WORKER_TERMINALS: "on" }, "win32").enabled, true);

  let launch;
  const fakeChild = { pid: 42, once() {}, unref() {} };
  const launched = launchWorkerTerminal({
    run: { id: "run-1", kind: "analysis", agent_id: "alpha", team_stage: "initial", model: "test-model", effort: "high", attempt: 1, pid: 41, worker_cwd: root },
    stdoutPath,
    stderrPath,
    completionPath,
    config: workerTerminalConfig({ ANTIGRAVITY_WORKER_TERMINALS: "on" }, "win32"),
  }, {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    scriptPath: viewer,
    launcherPath: path.join(path.dirname(viewer), "worker-terminal.cmd"),
    spawn(command, args, options) { launch = { command, args, options }; return fakeChild; },
  });
  assert.equal(launched.mode, "cmd");
  assert.equal(launched.launcher_pid, 42);
  assert.equal(launch.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(launch.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.match(Buffer.from(launch.args[4], "base64").toString("utf16le"), /Start-Process[\s\S]*WindowStyle Normal/);
  assert.equal(launch.options.cwd, path.dirname(viewer));
  assert.equal(launch.options.detached, undefined);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.stdio, "ignore");
  const launchPayload = JSON.parse(Buffer.from(launch.options.env.ANTIGRAVITY_TERMINAL_PAYLOAD, "base64url").toString("utf8"));
  assert.equal(launchPayload.agent_id, "alpha");
  assert.equal(launchPayload.completion_path, completionPath);
  assert.equal(launchPayload.ready_path, `${completionPath}.viewer-ready`);

  await Promise.all([fs.writeFile(stdoutPath, ""), fs.writeFile(stderrPath, "")]);
  const payload = {
    run_id: "viewer-test",
    kind: "analysis",
    agent_id: "alpha",
    team_stage: "initial",
    model: "mock-model",
    effort: "high",
    attempt: 1,
    worker_pid: process.pid,
    cwd: root,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    completion_path: completionPath,
    ready_path: `${completionPath}.viewer-ready`,
    poll_ms: 25,
    exit_when_complete: true,
  };
  const child = spawn(process.execPath, [viewer, "--view-worker"], {
    env: {
      ...process.env,
      ANTIGRAVITY_TERMINAL_TEST_OUTPUT: "stdout",
      ANTIGRAVITY_TERMINAL_TEST_COLOR: "1",
      ANTIGRAVITY_TERMINAL_PAYLOAD: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  await new Promise(resolve => setTimeout(resolve, 75));
  await fs.writeFile(stdoutPath, JSON.stringify({
    status: "SUCCESS",
    response: "Hello from the worker!",
    duration_seconds: 1.25,
    num_turns: 2,
    usage: { input_tokens: 10, output_tokens: 5 },
  }), "utf8");
  await fs.writeFile(stderrPath, "internal diagnostic that should stay hidden on success\n", "utf8");
  await fs.writeFile(completionPath, JSON.stringify({ status: "succeeded", exit_code: 0 }), "utf8");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, errors);
  const plainOutput = output.replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(output, /\u001b\[96m/);
  assert.match(output, /\u001b\[93m/);
  const agentInfoIndex = plainOutput.indexOf("ANTIGRAVITY AGENT");
  const responseIndex = plainOutput.indexOf("Hello from the worker!");
  const metadataIndex = plainOutput.indexOf("RUN METADATA");
  assert.equal(agentInfoIndex >= 0, true);
  assert(agentInfoIndex < responseIndex);
  assert(responseIndex < metadataIndex);
  assert.match(plainOutput, /Agent\s+alpha/);
  assert.match(plainOutput, /Type\s+analysis/);
  assert.match(plainOutput, /Model\s+mock-model/);
  assert.match(plainOutput, /Effort\s+high/);
  assert.match(plainOutput, /---[\s\S]*Status\s+Succeeded/);
  assert.match(plainOutput, /Input tokens\s+10/);
  assert.match(plainOutput, /Output tokens\s+5/);
  assert.match(plainOutput, /Total tokens\s+15/);
  assert.match(plainOutput, /Duration\s+1.25 seconds/);
  assert.match(plainOutput, /Turns\s+2/);
  assert.match(plainOutput, /Run ID\s+viewer-test/);
  assert.match(plainOutput, /Close this window when you're done\./);
  assert.doesNotMatch(plainOutput, /internal diagnostic/);
  assert.equal(JSON.parse(await fs.readFile(`${completionPath}.viewer-ready`, "utf8")).pid, child.pid);

  if (process.platform === "win32") {
    const launcher = path.join(path.dirname(viewer), "worker-terminal.cmd");
    const cmd = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", path.basename(launcher)], {
      cwd: path.dirname(launcher),
      env: {
        ...process.env,
        ANTIGRAVITY_TERMINAL_NODE: process.execPath,
        ANTIGRAVITY_TERMINAL_SCRIPT: viewer,
        ANTIGRAVITY_TERMINAL_TEST_OUTPUT: "stdout",
        ANTIGRAVITY_TERMINAL_PAYLOAD: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let cmdOutput = "", cmdErrors = "";
    cmd.stdout.on("data", chunk => { cmdOutput += chunk; });
    cmd.stderr.on("data", chunk => { cmdErrors += chunk; });
    const cmdExit = await new Promise((resolve, reject) => {
      cmd.once("error", reject);
      cmd.once("close", resolve);
    });
    assert.equal(cmdExit, 0, cmdErrors);
    assert(cmdOutput.indexOf("ANTIGRAVITY AGENT") < cmdOutput.indexOf("Hello from the worker!"));
    assert(cmdOutput.indexOf("Hello from the worker!") < cmdOutput.indexOf("RUN METADATA"));
    assert.match(cmdOutput, /Status\s+Succeeded/);
  }
  const launcherText = await fs.readFile(path.join(path.dirname(viewer), "worker-terminal.cmd"), "utf8");
  assert.match(launcherText, /chcp 65001 >nul/i);
  assert.match(launcherText, /color 0A/i);
  assert(launcherText.indexOf("chcp 65001") < launcherText.indexOf("color 0A"));
  assert(launcherText.indexOf("color 0A") < launcherText.indexOf("ANTIGRAVITY_TERMINAL_NODE"));
  process.stdout.write("Windows worker terminal colors and agent-response-metadata formatting: OK\n");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
