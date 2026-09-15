import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, "..", "server", "index.mjs");
const project = path.resolve(here, "..");
const state = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-workers-real-"));
const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    ANTIGRAVITY_STATE_DIR: state,
    ANTIGRAVITY_AGY_PATH: process.env.ANTIGRAVITY_AGY_PATH || (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || os.homedir(), "agy", "bin", "agy.exe") : "agy"),
    ANTIGRAVITY_MAX_WORKERS: "1",
  },
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message.result);
  }
});
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`Timed out waiting for ${method}`));
  }, 180_000);
  pending.set(id, (result) => {
    clearTimeout(timer);
    resolve(result);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});

try {
  await request("initialize", { protocolVersion: "2025-06-18" });
  const doctor = await request("tools/call", { name: "doctor", arguments: {} });
  assert.equal(doctor.structuredContent.ok, true, doctor.content?.[0]?.text);
  const started = await request("tools/call", {
    name: "start_analysis",
    arguments: {
      cwd: project,
      task: "Read .codex-plugin/plugin.json using a file-reading tool, verify its name is antigravity-workers, then reply exactly MCP_REAL_OK. Do not modify files or run terminal commands.",
      timeout_minutes: 3,
    },
  });
  assert.equal(started.isError, false, started.content?.[0]?.text);
  let completed;
  do {
    completed = await request("tools/call", {
      name: "get_run",
      arguments: { run_id: started.structuredContent.id, wait_ms: 30000 },
    });
  } while (completed.structuredContent.status === "running");
  assert.equal(completed.structuredContent.status, "succeeded", completed.content?.[0]?.text);
  assert.match(completed.structuredContent.response, /MCP_REAL_OK/);
  if (process.env.ANTIGRAVITY_MEDIA_SMOKE_FILE) {
    const mediaStarted = await request("tools/call", {
      name: "start_media_analysis",
      arguments: {
        file_paths: [path.resolve(process.env.ANTIGRAVITY_MEDIA_SMOKE_FILE)],
        task: "Inspect the supplied file natively and describe its dominant visible content in one sentence. Do not run commands.",
        model_policy: "fast",
        timeout_minutes: 3,
      },
    });
    do {
      completed = await request("tools/call", { name: "get_media_run", arguments: { run_id: mediaStarted.structuredContent.id, wait_ms: 30000 } });
    } while (["queued", "running"].includes(completed.structuredContent.status));
    assert.equal(completed.structuredContent.status, "succeeded", completed.content?.[0]?.text);
    assert(String(completed.structuredContent.response || "").trim());
  }
  if (process.env.ANTIGRAVITY_IMAGE_SMOKE === "1") {
    const imageStarted = await request("tools/call", {
      name: "start_image_generation",
      arguments: { prompt: "A simple solid blue square centered on a white background. No text.", output_name: "real-smoke", model_policy: "fast", timeout_minutes: 5 },
    });
    do {
      completed = await request("tools/call", { name: "get_media_run", arguments: { run_id: imageStarted.structuredContent.id, wait_ms: 30000 } });
    } while (["queued", "running"].includes(completed.structuredContent.status));
    assert.equal(completed.structuredContent.status, "succeeded", completed.content?.[0]?.text);
    assert(completed.structuredContent.artifacts?.length, completed.content?.[0]?.text);
    assert(completed.content.some((item) => item.type === "image"));
  }
  process.stdout.write(`Real Antigravity MCP code, media, and image smoke test: OK (${doctor.structuredContent.agy_version})\n`);
} finally {
  child.kill();
  await fs.rm(state, { recursive: true, force: true });
}
