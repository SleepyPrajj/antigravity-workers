// One scheduler per state directory. Other MCP hosts are transport-only proxies.
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export async function openRuntime({ stateRoot, dispatch, initialize, isIdle }) {
  const canonical = await fs.realpath(stateRoot);
  const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex").slice(0, 32);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\codex-agy-${key}`
    : process.platform === "linux" ? `\0codex-agy-${key}` : path.join(os.tmpdir(), `codex-agy-${key}.sock`);
  const authPath = path.join(stateRoot, "runtime-auth.json");
  const connections = new Set();
  let ready, token, frontendClosed = false, active = 0;
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return socket.destroy();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let request;
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!token || request.token !== token) { socket.destroy(); return; }
        active++;
        Promise.resolve(ready).then(() => dispatch(request.name, request.args)).then(
          result => socket.write(JSON.stringify({ id: request.id, result }) + "\n"),
          error => socket.write(JSON.stringify({ id: request.id, error: error.message }) + "\n"),
        ).finally(() => active--);
      }
    });
    Promise.resolve().then(() => ready).then(() => socket.write('{"ready":true}\n'), () => socket.destroy());
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: endpoint, exclusive: true }, () => { server.removeListener("error", reject); resolve(); });
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
    // Never recover shared jobs in a proxy. A dropped RPC is NOT automatically
    // retried: a mutation might already have succeeded at the owner.
    const socket = net.createConnection(endpoint);
    socket.setEncoding("utf8");
    let sequence = 0, buffer = "", failed;
    const pending = new Map();
    let resolveReady, rejectReady;
    const connected = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const fail = error => {
      failed = error;
      rejectReady(error);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
      pending.clear();
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("Shared scheduler disconnected; inspect saved run IDs before reconnecting. No request was retried.")));
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 64 * 1024 * 1024) return socket.destroy(new Error("Runtime response too large"));
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(new Error("Invalid runtime response")); return; }
        if (message.ready) { resolveReady(); continue; }
        const p = pending.get(message.id);
        if (p) { pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error(message.error)) : p.resolve(message.result); }
      }
    });
    const connectionTimer = setTimeout(() => socket.destroy(new Error("Scheduler handshake timed out")), 30_000);
    try { await connected; } finally { clearTimeout(connectionTimer); }
    const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
    return {
      owner: false,
      request(name, args) {
        if (failed) return Promise.reject(failed);
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error("Scheduler request timed out; inspect the ledger before retrying.")); }, 150_000);
          pending.set(id, { resolve, reject, timer });
          socket.write(JSON.stringify({ id, token: auth.token, name, args }) + "\n");
        });
      },
      closeFrontend() { socket.end(); },
    };
  }
  token = randomBytes(32).toString("hex");
  ready = (async () => {
    await fs.writeFile(authPath, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    await initialize();
  })();
  try { await ready; } catch (error) { server.close(); for (const socket of connections) socket.destroy(); throw error; }
  server.on("error", error => process.stderr.write(`Shared scheduler: ${error.message}\n`));
  const shutdownTimer = setInterval(() => {
    if (frontendClosed && connections.size === 0 && active === 0 && isIdle()) {
      clearInterval(shutdownTimer); server.close();
    }
  }, 250);
  shutdownTimer.unref();
  return {
    owner: true,
    async request(name, args) { active++; try { return await dispatch(name, args); } finally { active--; } },
    closeFrontend() { frontendClosed = true; },
  };
}
