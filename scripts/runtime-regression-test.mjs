import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-runtime-regression-"));
const eventsFile = path.join(root, "events.jsonl");
const clients = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = s => !["queued", "running"].includes(s);
async function client() {
  const child = spawn(process.execPath, [path.join(here, "../server/index.mjs")], {
    env: { ...process.env, ANTIGRAVITY_STATE_DIR: root, ANTIGRAVITY_AGY_PATH: process.execPath, ANTIGRAVITY_AGY_PREFIX_ARGS_JSON: JSON.stringify([path.join(here, "mock-runtime-agy.mjs")]), ANTIGRAVITY_MAX_WORKERS: "2", ANTIGRAVITY_TEST_EVENTS: eventsFile },
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0, stderr = "";
  child.stderr.on("data", chunk => stderr += chunk);
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line), p = pending.get(message.id);
    if (p) { pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
  });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error(`${method} timeout ${stderr}`)); }, 15000);
      pending.set(key, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
    });
  }
  const c = { child, request, async tool(name, args = {}) {
    const result = await request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent;
  }};
  clients.push(c);
  await request("initialize");
  return c;
}
async function until(fn, check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (check(result)) return result; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const records = async () => (await fs.readFile(eventsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
const teamArgs = (extra = {}) => ({ cwd: here, objective: "TEST_OBJECTIVE", max_retries: 0, review_rounds: 1, agents: [{ id: "alpha", task: "TEST_SLOW TEST_ALPHA" }, { id: "beta", task: "TEST_SLOW TEST_BETA" }], ...extra });

try {
  const a = await client();
  const team = await a.tool("start_team", teamArgs());
  await until(() => a.tool("get_team", { team_id: team.id }), t => t.agents.some(x => x.current_run_id), "initial dispatch");
  const [b, c] = await Promise.all([client(), client()]);
  const healths = await Promise.all([a, b, c].map(x => x.tool("doctor")));
  assert.equal(new Set(healths.map(x => x.scheduler_pid)).size, 1);
  assert.equal(healths[0].scheduler_pid, a.child.pid);
  await Promise.all([
    b.tool("message_agent", { team_id: team.id, to_agent_id: "coordinator", message: "TEST_EARLY_MESSAGE" }),
    c.tool("message_agent", { team_id: team.id, to_agent_id: "alpha", message: "TEST_AGENT_MESSAGE" }),
  ]);
  const complete = await until(() => b.tool("get_team", { team_id: team.id, include_transcript: true }), t => terminal(t.status), "complete team");
  assert.equal(complete.status, "awaiting-codex-review", complete.error);
  assert.equal(complete.events.filter(e => e.type === "correction_round_completed").length, 1);
  assert(!complete.events.some(e => e.type === "interrupted"));
  assert(complete.messages.filter(m => m.kind === "peer-message").every(m => m.delivery === "injected"));
  let logs = await records();
  assert(logs.some(x => x.prompt.includes("You coordinate a team") && x.prompt.includes("TEST_EARLY_MESSAGE")));
  assert(logs.some(x => x.prompt.includes("The team coordinator reviewed") && x.prompt.includes("TEST_AGENT_MESSAGE")));
  console.log("PASS: three hosts share one owner; active team survives joins; early messages are injected at safe boundaries");

  const pendingTeam = await b.tool("start_team", teamArgs({ review_rounds: 3, agents: Array.from({length:6}, (_, i) => ({id:`a${i}`, task:`TEST_SLOW TEST_CANCEL_${i}`})) }));
  await until(() => a.tool("get_team", { team_id: pendingTeam.id }), t => t.agents.every(x => x.current_run_id), "queued children");
  await c.tool("cancel_team", { team_id: pendingTeam.id });
  await until(() => a.tool("doctor"), d => d.active_runs === 0 && d.queued_runs === 0, "drained cancellation");
  await sleep(1200);
  const cancelled = await b.tool("get_team", { team_id: pendingTeam.id });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.coordinator.run_ids.length, 0);
  const runs = (await c.tool("list_runs", { limit: 100 })).runs.filter(r => r.team_id === pendingTeam.id);
  assert(runs.every(r => r.status === "cancelled"));
  assert(runs.filter(r => r.started_at).length <= 2, "cancelled queue launched later");
  console.log("PASS: cross-host cancellation stays terminal and never dispatches queued work or a coordinator");

  const parent = await a.tool("start_analysis", {cwd:here, task:"TEST_PARENT", max_retries:0});
  await until(() => b.tool("get_run", {run_id:parent.id}), r=>terminal(r.status), "parent");
  const followups = await Promise.all([b,c].map(x=>x.tool("continue_run", {run_id:parent.id,prompt:"TEST_SLOW TEST_FOLLOWUP",max_retries:0})));
  await Promise.all(followups.map(r=>until(()=>a.tool("get_run",{run_id:r.id}),x=>terminal(x.status),"followup")));
  logs = (await records()).filter(x=>x.prompt.includes("TEST_FOLLOWUP"));
  assert.deepEqual(logs.map(x=>x.event),["start","end","start","end"]);
  console.log("PASS: concurrent continuations of the same conversation are serialized");

  const fail = await a.tool("start_team", teamArgs({objective:"TEST_FAIL_COORD",agents:[{task:"TEST_FAST"},{task:"TEST_FAST"}]}));
  const failed = await until(()=>c.tool("get_team",{team_id:fail.id}),t=>terminal(t.status),"failed coordinator");
  assert.equal(failed.status,"failed");
  assert(!failed.events.some(e=>e.type==="correction_round_started"));
  console.log("PASS: failed coordinator cannot trigger fake correction rounds");
  assert.equal((await a.tool("doctor")).active_runs,0);

  // Closing the owner's MCP frontend must not kill work served to other hosts.
  a.child.stdin.end();
  await sleep(300);
  assert.equal((await b.tool("doctor")).scheduler_pid, a.child.pid);
  const orphanTeam = await b.tool("start_team", teamArgs({agents:Array.from({length:4},(_,i)=>({id:`o${i}`,task:"TEST_SLOW TEST_ORPHAN"}))}));
  const beforeCrash = await until(()=>b.tool("get_team",{team_id:orphanTeam.id}),t=>t.agents.every(x=>x.current_run_id),"orphan queue");
  const oldRuns = await Promise.all(beforeCrash.agents.map(x=>b.tool("get_run",{run_id:x.current_run_id})));
  a.child.kill();
  await new Promise(resolve=>a.child.once("close",resolve));
  const d = await client();
  const recovered = await d.tool("get_team",{team_id:orphanTeam.id});
  assert.equal(recovered.status,"interrupted");
  for(const r of oldRuns.filter(x=>x.status==="queued")) assert.equal((await d.tool("get_run",{run_id:r.id})).status,"cancelled");
  const fresh = await d.tool("start_analysis",{cwd:here,task:"TEST_AFTER_CRASH",max_retries:0});
  const freshDone = await until(()=>d.tool("get_run",{run_id:fresh.id}),r=>terminal(r.status),"new owner after orphan exits");
  assert.equal(freshDone.status,"succeeded");
  const orphanStarts = (await records()).filter(x=>x.event==="start" && x.prompt.includes("TEST_ORPHAN"));
  assert(orphanStarts.length<=2,"new owner duplicated old queued children");
  console.log("PASS: owner frontend may detach; actual owner crash interrupts team once and does not replay queued children");
  console.log(`Runtime regression suite OK. Isolated test state: ${root}`);
} finally {
  // Only terminate child processes created by this isolated test, never app hosts.
  for (const c of clients.reverse()) { c.child.stdin.end(); c.child.kill(); }
  // Retain temporary evidence; no recursive delete of computed paths.
}
