#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const PREFIX = "vercel-deployment-mcp-packed-";
const TOKEN = "packed-token-canary-never-log";
const MAX_COMMAND_OUTPUT = 128 * 1024;
const MAX_SERVER_STDERR = 32 * 1024;
const STDERR_CLOSE_TIMEOUT = 2_000;
const REQUEST_OPTIONS = { timeout: 10_000, maxTotalTimeout: 10_000 };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
function inside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
async function bounded(promise, timeout, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isFile()) return candidate;
    } catch {}
  }
  throw new Error("setup: npm CLI was not found for the active Node runtime");
}
async function runNpm(label, npmCli, args, cwd, timeout) {
  try {
    return await execFileAsync(process.execPath, [npmCli, ...args], {
      cwd, timeout, maxBuffer: MAX_COMMAND_OUTPUT, windowsHide: true,
    });
  } catch (error) {
    throw new Error(`${label}: npm failed: ${String(error.stderr || error.message).trim()}`);
  }
}
function preloadSource() {
  return [
    'import { appendFileSync } from "node:fs";',
    'import childProcess from "node:child_process"; import cluster from "node:cluster"; import dgram from "node:dgram"; import dns from "node:dns";',
    'import http from "node:http"; import http2 from "node:http2"; import https from "node:https"; import inspector from "node:inspector"; import inspectorPromises from "node:inspector/promises"; import net from "node:net";',
    'import tls from "node:tls"; import workerThreads from "node:worker_threads"; import { syncBuiltinESMExports } from "node:module";',
    'const marker = process.env.PACKED_SMOKE_MARKER;',
    'const expectedVersion = process.env.PACKED_SMOKE_NODE_VERSION; const expectedPath = process.env.PACKED_SMOKE_EXPECTED_PATH;',
    'const token = process.env.VERCEL_TOKEN;',
    'if (!marker || !expectedVersion || !expectedPath || !token) throw new Error("packed-smoke preload configuration missing");',
    'if (process.version !== expectedVersion) throw new Error("packed-smoke child runtime mismatch");',
    'const denyExternal = function () { throw new Error("packed-smoke external I/O denied"); };',
    'const denied = [',
    '  [childProcess, ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]],',
    '  [cluster, ["fork", "setupMaster", "setupPrimary"]], [dgram, ["createSocket"]], [http, ["createServer", "get", "request"]], [http2, ["connect", "createSecureServer", "createServer"]], [https, ["createServer", "get", "request"]],',
    '  [inspector, ["open"]], [inspectorPromises, ["open"]], [net, ["connect", "createConnection", "createServer"]], [tls, ["connect", "createServer"]], [workerThreads, ["Worker"]],',
    '];',
    'for (const [module, names] of denied) for (const name of names) module[name] = denyExternal;',
    'for (const dnsModule of [dns, dns.promises]) {',
    '  const Resolver = dnsModule.Resolver; for (const name of Object.getOwnPropertyNames(Resolver.prototype)) if (name !== "constructor") Resolver.prototype[name] = denyExternal;',
    '  for (const name of Object.keys(dnsModule)) if (/^(lookup|resolve|reverse)/.test(name)) dnsModule[name] = denyExternal; dnsModule.Resolver = denyExternal;',
    '}',
    'childProcess.ChildProcess.prototype.spawn = denyExternal; for (const name of Object.getOwnPropertyNames(dgram.Socket.prototype)) { const property = Object.getOwnPropertyDescriptor(dgram.Socket.prototype, name); if (name !== "constructor" && typeof property?.value === "function") dgram.Socket.prototype[name] = denyExternal; } dgram.Socket = denyExternal; net.Server.prototype.listen = denyExternal; net.Socket.prototype.connect = denyExternal;',
    'tls.TLSSocket.prototype.connect = denyExternal; process.dlopen = denyExternal; if (typeof process.execve === "function") process.execve = denyExternal; if ("WebSocket" in globalThis) globalThis.WebSocket = denyExternal; if ("EventSource" in globalThis) globalThis.EventSource = denyExternal;',
    'syncBuiltinESMExports();',
    'for (const probe of [() => new dgram.Socket({ type: "udp4" }), () => new dns.Resolver(), () => http.request("http://127.0.0.1"), () => inspector.open(0), () => net.createServer()]) try { probe(); throw new Error("packed-smoke network guard missing"); } catch (error) { if (error?.message !== "packed-smoke external I/O denied") throw error; }',
    'appendFileSync(marker, JSON.stringify({ type: "runtime", version: process.version }) + "\\n");',
    'let calls = 0;',
    'globalThis.fetch = async (input, init = {}) => {',
    '  calls += 1;',
    '  const url = new URL(String(input));',
    '  const headers = new Headers(init.headers);',
    '  const method = init.method ?? "GET";',
    '  const fail = (reason) => { throw new Error("packed-smoke fetch contract: " + reason); };',
    '  if (calls !== 1) fail("call-count");',
    '  if (url.origin !== "https://api.vercel.com" || url.pathname !== expectedPath) fail("url");',
    '  if (url.username !== "" || url.password !== "" || url.hash !== "") fail("url-components");',
    '  if (method !== "GET" || init.body != null) fail("request-shape");',
    '  if (headers.get("authorization") !== "Bearer " + token) fail("authorization");',
    '  if (headers.get("content-type") !== "application/json" || [...headers.keys()].length !== 2) fail("headers");',
    '  const expected = { projectId: "prj_packed", state: "READY", limit: "1" };',
    '  if (url.searchParams.size !== 3) fail("query-count");',
    '  for (const [key, value] of Object.entries(expected)) {',
    '    if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) fail("query");',
    '  }',
    '  appendFileSync(marker, JSON.stringify({ type: "fetch", calls, method, path: url.pathname }) + "\\n");',
    '  return new Response(JSON.stringify({ deployments: [{ uid: "dpl_packed", name: "packed-app", readyState: "READY", ignored: true }] }), { status: 200 });',
    '};',
  ].join("\n");
}
async function markerEvents(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function removeVerified(root, tempBase) {
  if (!root) return;
  const info = await lstat(root);
  const canonical = await realpath(root);
  assert.equal(info.isDirectory(), true, "cleanup: root is not a directory");
  assert.equal(info.isSymbolicLink(), false, "cleanup: root is a symlink");
  assert.equal(dirname(canonical), tempBase, "cleanup: root escaped temp directory");
  assert.equal(basename(canonical).startsWith(PREFIX), true, "cleanup: unexpected root name");
  await rm(canonical, { recursive: true, maxRetries: 3, retryDelay: 100 });
}
async function main() {
  const tempBase = await realpath(tmpdir());
  const npmCli = await findNpmCli();
  let root;
  let client;
  try {
    root = await mkdtemp(join(tempBase, PREFIX));
    const canonicalRoot = await realpath(root);
    assert.equal(dirname(canonicalRoot), tempBase, "setup: temporary root escaped parent");
    const packDir = join(canonicalRoot, "pack");
    const consumerDir = join(canonicalRoot, "consumer");
    const markerPath = join(canonicalRoot, "preload-events.jsonl");
    const preloadPath = join(canonicalRoot, "fetch-preload.mjs");
    await mkdir(packDir);
    await mkdir(consumerDir);
    await writeFile(preloadPath, preloadSource(), { flag: "wx" });
    const packed = await runNpm(
      "pack",
      npmCli,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
      repoRoot,
      60_000,
    );
    const packResult = JSON.parse(packed.stdout);
    assert.equal(packResult.length, 1, "pack: expected one result");
    const metadata = packResult[0];
    const tarball = await realpath(resolve(packDir, metadata.filename));
    assert.equal(inside(await realpath(packDir), tarball), true, "pack: tarball escaped destination");
    const packedFiles = metadata.files.map((file) => file.path).sort();
    assert.deepEqual(packedFiles, [
      "LICENSE", "README.md", "dist/index.js", "dist/tools.js", "dist/vercel.js", "package.json",
    ]);
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify({ name: "packed-consumer", version: "0.0.0", private: true }),
      { flag: "wx" },
    );
    await runNpm(
      "install",
      npmCli,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--no-save", tarball],
      consumerDir,
      120_000,
    );
    const installedDir = join(consumerDir, "node_modules", "@addiplus", "vercel-deployment-mcp");
    const installedPackage = JSON.parse(await readFile(join(installedDir, "package.json"), "utf8"));
    assert.equal(installedPackage.name, "@addiplus/vercel-deployment-mcp");
    assert.deepEqual(installedPackage.bin, { "vercel-deployment-mcp": "dist/index.js" });
    await lstat(join(installedDir, "dist", "index.js"));
    const shim = join(
      consumerDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "vercel-deployment-mcp.cmd" : "vercel-deployment-mcp",
    );
    await lstat(shim);
    const expectedPath = process.env.PACKED_SMOKE_EXPECTED_PATH ?? "/v6/deployments";
    const transport = new StdioClientTransport({
      command: shim,
      cwd: consumerDir,
      stderr: "pipe",
      env: {
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
        NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
        PACKED_SMOKE_MARKER: markerPath,
        PACKED_SMOKE_NODE_VERSION: process.version,
        PACKED_SMOKE_EXPECTED_PATH: expectedPath,
        VERCEL_TOKEN: TOKEN,
      },
    });
    const stderrStream = transport.stderr;
    assert.ok(stderrStream, "setup: server stderr pipe missing");
    const stderrEnded = Promise.race([once(stderrStream, "end"), once(stderrStream, "close")]);
    const stderrChunks = [];
    let stderrBytes = 0;
    let stderrOverflow = false;
    stderrStream.on("data", (chunk) => {
      if (stderrOverflow) return;
      const buffer = Buffer.from(chunk);
      const remaining = MAX_SERVER_STDERR - stderrBytes;
      if (buffer.byteLength > remaining) {
        if (remaining > 0) {
          stderrChunks.push(buffer.subarray(0, remaining));
          stderrBytes += remaining;
        }
        stderrOverflow = true;
        void transport.close();
        return;
      }
      stderrChunks.push(buffer);
      stderrBytes += buffer.byteLength;
    });
    client = new Client({ name: "packed-consumer-smoke", version: "0.0.0" });
    await client.connect(transport, REQUEST_OPTIONS);
    const runtimeEvents = await markerEvents(markerPath);
    assert.deepEqual(runtimeEvents, [{ type: "runtime", version: process.version }]);
    const listed = await client.listTools(undefined, REQUEST_OPTIONS);
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["get_deployment", "get_project", "list_deployments", "list_projects"]);
    for (const tool of listed.tools) {
      assert.equal(tool.outputSchema?.type, "object");
    }
    const result = await client.callTool(
      { name: "list_deployments", arguments: { projectId: "prj_packed", state: "READY", limit: 1 } },
      undefined,
      REQUEST_OPTIONS,
    );
    const expected = {
      pageCount: 1,
      items: [{ id: "dpl_packed", name: "packed-app", state: "READY", target: null }],
      receipt: { scopeKind: "personal", appliedFilters: ["projectId", "state"], endpointProfile: "vercel-read-v1" },
    };
    assert.notEqual(result.isError, true, "call: installed tool returned an error");
    assert.deepEqual(result.structuredContent, expected);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(expected, null, 2) }]);
    const events = await markerEvents(markerPath);
    const serverVersion = client.getServerVersion();
    const serverCapabilities = client.getServerCapabilities();
    await client.close();
    await bounded(stderrEnded, STDERR_CLOSE_TIMEOUT, "server stderr did not close");
    client = undefined;
    const serverStderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
    assert.deepEqual(events, [
      { type: "runtime", version: process.version },
      { type: "fetch", calls: 1, method: "GET", path: "/v6/deployments" },
    ]);
    assert.equal(stderrOverflow, false, "server stderr exceeded limit");
    const leakSurface = JSON.stringify([
      serverVersion, serverCapabilities, listed, result, events, serverStderr,
    ]);
    assert.equal(leakSurface.includes(TOKEN), false, "token canary leaked");
    console.log(`packed consumer smoke passed (${process.version})`);
  } finally {
    try {
      if (client) await client.close();
    } finally {
      await removeVerified(root, tempBase);
    }
  }
}
main().catch((error) => {
  const detail = String(error?.stack ?? error).replaceAll(TOKEN, "[redacted]").slice(0, 4096);
  console.error(`packed consumer smoke failed: ${detail}`);
  process.exitCode = 1;
});
