import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

function send(child: ChildProcessWithoutNullStreams, msg: unknown): void {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function waitForId(
  responses: Map<number, unknown>,
  id: number,
  timeoutMs: number,
  stderrRef: () => string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer);
        resolve(responses.get(id));
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for id ${id}; stderr so far: ${stderrRef()}`));
      }
    }, 20);
  });
}

// Node writes to a pipe asynchronously, so a stderr line can land a tick after the
// response frame it accompanies. Measured on Linux the line is already present when the
// id 3 response resolves, 20 runs out of 20, so this poll returns on its first tick; it
// is here for the Windows runner, which is not measured. A fixed setTimeout would trade a
// flake for a guaranteed delay, so do not substitute one.
function waitForStderr(
  stderrRef: () => string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (stderrRef() === expected) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`stderr never settled; saw: ${JSON.stringify(stderrRef())}`));
      }
    }, 20);
  });
}

// Every request frame below carries this as params._meta. A frame without it is
// a 2025 frame: serveStdio classifies a claim-less opening as legacy, pins a
// legacy instance, and never installs the modern-only handlers, so a
// server/discover sent without this envelope comes back as -32601 Method not
// found. Both keys are required; dropping clientCapabilities gives -32602.
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "contract-test-2026", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

// The whole of stderr is asserted against these, so they live at module scope rather than
// being inlined at each assertion. ERA_REFUSAL_LINE is one line on the wire; it is written
// as a concatenation only so the source stays inside the line length this repo uses.
const BANNER = "vercel-deployment-mcp ready (stdio)\n";
const TRANSPORT_PREFIX = "vercel-deployment-mcp transport error: ";
const ERA_REFUSAL_LINE =
  `${TRANSPORT_PREFIX}Rejected 2025-era request on a modern-only stdio connection ` +
  `(modern-only-missing-envelope): Unsupported protocol version: 2025-06-18\n`;

describe("stdio era negotiation", () => {
  it(
    "serves the 2026-07-28 era to a client that claims it",
    async () => {
      const token = "vc_wire_token_canary";
      const teamId = "team_wire_canary";
      const env = { ...process.env, VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId };
      delete env.NODE_OPTIONS;
      const child = spawn(process.execPath, ["dist/index.js"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutLines: string[] = [];
      const responses = new Map<number, unknown>();
      let stdoutBuffer = "";
      let stderrBuffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (line.trim().length === 0) continue;
          stdoutLines.push(line);
          try {
            const parsed = JSON.parse(line) as { id?: number };
            if (parsed.id !== undefined) responses.set(parsed.id, parsed);
          } catch {
            // Retain non-JSON output so the purity assertion can report it.
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
      });

      try {
        // The opening frame. A modern server/discover puts the connection in the
        // probe phase: an instance is built and answers, but the era is not yet
        // pinned.
        send(child, { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: ENVELOPE } });
        await waitForId(responses, 1, 20_000, () => stderrBuffer);
        const discover = responses.get(1) as {
          error?: unknown;
          result?: {
            supportedVersions?: string[];
            capabilities?: Record<string, unknown>;
            resultType?: string;
            _meta?: Record<string, unknown>;
          };
        };
        expect(discover.error).toBeUndefined();
        // This is the negotiated revision as it is observable from outside the
        // process: getNegotiatedProtocolVersion() is in-process only.
        expect(discover.result?.supportedVersions).toEqual(["2026-07-28"]);
        expect(discover.result?.capabilities).toHaveProperty("tools");
        expect(discover.result?.resultType).toBe("complete");
        expect(discover.result?._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
          name: "vercel-deployment-mcp",
          version: pkg.version,
        });

        // The first modern non-discover request is what PINS the connection to
        // the modern era. Do not reorder this with the initialize below.
        send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: ENVELOPE } });
        await waitForId(responses, 2, 20_000, () => stderrBuffer);
        const listed = responses.get(2) as {
          error?: unknown;
          result?: { tools?: Array<{ name: string; outputSchema?: unknown }>; resultType?: string };
        };
        expect(listed.error).toBeUndefined();
        expect((listed.result?.tools ?? []).map((t) => t.name).sort()).toEqual([
          "get_deployment",
          "get_project",
          "list_deployments",
          "list_projects",
        ]);
        expect(listed.result?.resultType).toBe("complete");
        for (const tool of listed.result?.tools ?? []) expect(tool.outputSchema).toBeDefined();

        // The connection reached the modern era without an initialize, which is what
        // the handshake check has to allow: a refusal here would be -32600.
        expect(discover.error).toBeUndefined();
        expect(listed.error).toBeUndefined();

        // The connection is now pinned to 2026-07-28, so a 2025 initialize on it
        // is refused by revision rather than answered. Under the old wiring
        // (server.connect(new StdioServerTransport())) this same frame returns a
        // normal 2025 InitializeResult, so this is the assertion the flip has to
        // earn.
        send(child, {
          jsonrpc: "2.0",
          id: 3,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "contract-test-2026", version: "0.0.0" },
          },
        });
        await waitForId(responses, 3, 20_000, () => stderrBuffer);
        const afterPin = responses.get(3) as {
          error?: { code?: number; data?: { supported?: string[] } };
        };
        expect(afterPin.error?.code).toBe(-32022);
        expect(afterPin.error?.data?.supported).toEqual(["2026-07-28"]);

        for (const line of stdoutLines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
        // Exact, on both lines. The id 3 frame above is a 2025 initialize on a connection
        // already pinned to 2026-07-28, which is the transport error this card reports.
        // stderr is the banner and exactly one reporter line, in that order, and nothing
        // else: no stack, no second line, no repeat.
        await waitForStderr(() => stderrBuffer, BANNER + ERA_REFUSAL_LINE, 5_000);
        expect(stderrBuffer).toBe(BANNER + ERA_REFUSAL_LINE);
        expect(stderrBuffer).not.toMatch(new RegExp(`${token}|${teamId}`));
        for (const line of stdoutLines) expect(line).not.toMatch(new RegExp(`${token}|${teamId}`));
        expect(stdoutLines.some((line) => line.includes("ready (stdio)"))).toBe(false);
      } finally {
        child.kill();
      }
    },
    20_000,
  );

  it(
    "redacts a configured credential out of a transport error before it reaches stderr",
    async () => {
      const token = "vc_wire_token_canary";
      const teamId = "team_wire_canary";
      const env = { ...process.env, VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId };
      delete env.NODE_OPTIONS;
      const child = spawn(process.execPath, ["dist/index.js"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutLines: string[] = [];
      const responses = new Map<number, unknown>();
      let stdoutBuffer = "";
      let stderrBuffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (line.trim().length === 0) continue;
          stdoutLines.push(line);
          try {
            const parsed = JSON.parse(line) as { id?: number };
            if (parsed.id !== undefined) responses.set(parsed.id, parsed);
          } catch {
            // Retain non-JSON output so the purity assertion can report it.
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
      });

      try {
        // The claimed revision is the configured token. The SDK puts the claimed string
        // verbatim into the UnsupportedProtocolVersionError message, so this is the one
        // externally reachable path that can carry a credential-shaped value into a
        // transport error, and therefore the path worth pinning.
        send(child, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": token,
              "io.modelcontextprotocol/clientInfo": { name: "contract-test-2026", version: "0.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        });
        await waitForId(responses, 1, 20_000, () => stderrBuffer);
        const refused = responses.get(1) as { error?: { code?: number } };
        expect(refused.error?.code).toBe(-32022);

        const expected = `${BANNER}${TRANSPORT_PREFIX}Unsupported protocol version: [redacted]\n`;
        await waitForStderr(() => stderrBuffer, expected, 5_000);
        expect(stderrBuffer).toBe(expected);
        expect(stderrBuffer).not.toContain(token);
        expect(stderrBuffer).not.toContain(teamId);
        for (const line of stdoutLines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
        // The other half of the split, asserted rather than described: the -32022
        // frame on stdout carries the revision the client itself claimed, which is
        // this token, back to that same client. That is the client's own string
        // returning to its sender rather than a value this server composed into an
        // error, which is the carve-out README.md claim 1 names; a redaction here
        // would hide from a client which of its claims was refused.
        const refusedFrame = JSON.stringify(refused);
        expect(refusedFrame).toContain(token);
        expect(refusedFrame).not.toContain("[redacted]");
      } finally {
        child.kill();
      }
    },
    20_000,
  );
});
