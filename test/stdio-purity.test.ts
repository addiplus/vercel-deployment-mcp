import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";

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

describe("stdio purity", () => {
  it(
    "keeps stdout limited to JSON-RPC frames and routes diagnostics to stderr",
    async () => {
      const env = { ...process.env };
      delete env.VERCEL_TOKEN;
      delete env.VERCEL_TEAM_ID;

      const child = spawn(process.execPath, ["dist/index.js"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutLines: string[] = [];
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const responses = new Map<number, unknown>();

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
            // left in stdoutLines verbatim so the purity assertion below can catch it
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
      });

      try {
        send(child, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "purity-test", version: "0.0.0" },
          },
        });
        await waitForId(responses, 1, 20_000, () => stderrBuffer);

        send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

        send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
        await waitForId(responses, 2, 20_000, () => stderrBuffer);

        send(child, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "list_projects", arguments: {} },
        });
        await waitForId(responses, 3, 20_000, () => stderrBuffer);

        for (const line of stdoutLines) {
          const parsed = JSON.parse(line);
          expect(parsed.jsonrpc).toBe("2.0");
        }

        const listResult = responses.get(2) as { result?: { tools?: unknown[] } };
        expect(listResult.result?.tools).toHaveLength(4);

        const callResult = responses.get(3) as {
          result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
        };
        expect(callResult.result?.isError).toBe(true);
        expect(callResult.result?.content?.[0]?.text).toContain("VERCEL_TOKEN");

        expect(stderrBuffer).toContain("vercel-deployment-mcp ready (stdio)");
        expect(stdoutLines.some((line) => line.includes("ready (stdio)"))).toBe(false);
      } finally {
        child.kill();
      }
    },
    20_000,
  );
});
