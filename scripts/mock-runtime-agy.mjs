// Only used by runtime-regression-test.mjs with an isolated temporary ledger.
import fs from "node:fs/promises";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("runtime-test mock 1"); process.exit(0); }
const value = flag => args[args.indexOf(flag) + 1];
const prompt = value("-p") || "";
const conversation = args.includes("--conversation") ? value("--conversation") : `test-${process.pid}`;
const log = event => fs.appendFile(process.env.ANTIGRAVITY_TEST_EVENTS, JSON.stringify({ event, pid: process.pid, conversation, prompt, at: Date.now() }) + "\n");
await log("start");
await new Promise(resolve => setTimeout(resolve, prompt.includes("TEST_SLOW") ? 1500 : 100));
await log("end");
const failed = prompt.includes("TEST_FAIL_COORD") && prompt.includes("You coordinate a team");
console.log(JSON.stringify({ conversation_id: conversation, status: failed ? "FAILED" : "SUCCESS", response: failed ? "" : `MOCK_OK ${(prompt.match(/TEST_[A-Z_]+/g) || []).join(" ")}`, error: failed ? "intentional coordinator failure" : undefined }));
if (failed) process.exitCode = 1;
