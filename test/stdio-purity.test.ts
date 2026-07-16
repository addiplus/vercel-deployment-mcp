import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import Ajv from "ajv";
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
    "keeps stdio pure and enforces structured output contracts",
    async () => {
      const token = "vc_wire_token_canary";
      const teamId = "team_wire_canary";
      const env = { ...process.env, VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId };
      delete env.NODE_OPTIONS;
      const fetchPreload = [
        "globalThis.fetch = async (input, init = {}) => {",
        "  const url = new URL(String(input));",
        "  if (url.origin !== 'https://api.vercel.com') throw new Error('unexpected origin');",
        "  if ((init.method ?? 'GET') !== 'GET' || init.body !== undefined) {",
        "    throw new Error('unexpected request');",
        "  }",
        "  let body;",
        "  switch (url.pathname) {",
        "    case '/v9/projects': body = { projects: [{ id: 'prj_1', name: 'demo' }] }; break;",
        "    case '/v9/projects/prj_wire': body = { id: 'prj_wire', name: 'demo' }; break;",
        "    case '/v9/projects/forbidden':",
        "      return new Response(",
        "        JSON.stringify({ error: { code: 'forbidden', message: 'denied' } }),",
        "        { status: 403 },",
        "      );",
        "    // Deployment identity is intentionally absent to prove partial success.",
        "    case '/v6/deployments':",
        "      body = { deployments: [{ name: 'app', readyState: 'READY' }] };",
        "      break;",
        "    case '/v13/deployments/dpl_wire':",
        "      body = { uid: 'dpl_wire', name: 'app', readyState: 'READY' };",
        "      break;",
        "    default: throw new Error('unexpected path: ' + url.pathname);",
        "  }",
        "  return new Response(JSON.stringify(body), { status: 200 });",
        "};",
      ].join("\n");
      const child = spawn(
        process.execPath,
        ["--import", `data:text/javascript,${encodeURIComponent(fetchPreload)}`, "dist/index.js"],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );

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
        send(child, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "contract-test", version: "0.0.0" },
          },
        });
        await waitForId(responses, 1, 20_000, () => stderrBuffer);
        send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
        send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
        await waitForId(responses, 2, 20_000, () => stderrBuffer);

        type Schema = {
          type?: string;
          properties?: Record<string, unknown>;
          required?: string[];
          additionalProperties?: boolean;
        };
        type Tool = {
          name: string;
          annotations?: Record<string, boolean>;
          outputSchema?: Schema;
        };
        const tools = ((responses.get(2) as { result?: { tools?: Tool[] } }).result?.tools ?? []);
        const properties: Record<string, string[]> = {
          list_projects: ["items", "pageCount", "receipt"],
          get_project: ["item", "receipt"],
          list_deployments: ["items", "pageCount", "receipt"],
          get_deployment: ["item", "receipt"],
        };
        expect(tools.map(({ name }) => name).sort()).toEqual(Object.keys(properties).sort());

        const ajv = new Ajv({ strict: false });
        for (const tool of tools) {
          expect(tool.annotations).toEqual({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          });
          const schema = tool.outputSchema!;
          expect(schema).toMatchObject({ type: "object", additionalProperties: false });
          expect(Object.keys(schema.properties ?? {}).sort()).toEqual(properties[tool.name].sort());
          expect(schema.required?.slice().sort()).toEqual(properties[tool.name].sort());
          expect(ajv.validateSchema(schema), JSON.stringify(ajv.errors)).toBe(true);
        }

        const receipt = (...appliedFilters: string[]) => ({
          scopeKind: "team",
          appliedFilters,
          endpointProfile: "vercel-read-v1",
        });
        const cases = [
          [
            "list_projects",
            { search: "demo" },
            {
              pageCount: 1, items: [{ id: "prj_1", name: "demo", framework: null }],
              receipt: receipt("search"),
            },
          ],
          [
            "get_project",
            { idOrName: "prj_wire" },
            {
              item: { id: "prj_wire", name: "demo", framework: null },
              receipt: receipt(),
            },
          ],
          [
            "list_deployments",
            { projectId: "prj_wire", state: "READY" },
            {
              pageCount: 1, items: [{ name: "app", state: "READY", target: null }],
              receipt: receipt("projectId", "state"),
            },
          ],
          [
            "get_deployment",
            { idOrUrl: "dpl_wire" },
            {
              item: { id: "dpl_wire", name: "app", state: "READY", target: null },
              receipt: receipt(),
            },
          ],
        ] as const;
        const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
        const invalidFilters: Record<string, string[]> = {
          list_projects: ["projectId"],
          get_project: ["state"],
          list_deployments: ["projectId", "projectId"],
          get_deployment: ["search"],
        };

        for (const [index, [name, args, expected]] of cases.entries()) {
          const id = index + 3;
          send(child, {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          });
          await waitForId(responses, id, 20_000, () => stderrBuffer);
          const frame = responses.get(id) as {
            error?: unknown;
            result?: {
              isError?: boolean;
              content?: Array<{ type: string; text?: string }>;
              structuredContent?: Record<string, unknown>;
            };
          };
          expect(frame.error).toBeUndefined();
          expect(frame.result?.isError, frame.result?.content?.[0]?.text).not.toBe(true);
          const structured = frame.result?.structuredContent;
          expect(structured).toEqual(expected);
          expect(JSON.parse(frame.result?.content?.[0]?.text ?? "")).toEqual(structured);
          const validate = ajv.compile(toolsByName.get(name)!.outputSchema!);
          expect(validate(structured), JSON.stringify(validate.errors)).toBe(true);
          if (name === "list_deployments") {
            const reordered = JSON.parse(JSON.stringify(structured)) as {
              receipt: { appliedFilters: string[] };
            };
            reordered.receipt.appliedFilters.reverse();
            expect(validate(reordered), JSON.stringify(validate.errors)).toBe(true);
          }
          const invalidReceipt = JSON.parse(JSON.stringify(structured)) as {
            receipt: { appliedFilters: string[] };
          };
          invalidReceipt.receipt.appliedFilters = invalidFilters[name];
          expect(
            validate(invalidReceipt),
            `${name}: ${JSON.stringify(validate.errors)}`,
          ).toBe(false);
          expect(JSON.stringify(frame.result)).not.toMatch(new RegExp(`${token}|${teamId}`));
          if ("pageCount" in expected) {
            expect(structured).not.toHaveProperty("hasMore");
            expect(structured).not.toHaveProperty("nextCursor");
          }
        }

        send(child, {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "get_project", arguments: { idOrName: "forbidden" } },
        });
        await waitForId(responses, 7, 20_000, () => stderrBuffer);
        const toolError = responses.get(7) as {
          error?: unknown;
          result?: { isError?: boolean; content?: unknown[]; structuredContent?: unknown };
        };
        expect([toolError.error, toolError.result?.isError]).toEqual([undefined, true]);
        expect(toolError.result?.content).toEqual([
          expect.objectContaining({ type: "text", text: expect.any(String) }),
        ]);
        expect(toolError.result?.structuredContent).toBeUndefined();
        expect(JSON.stringify(toolError)).not.toMatch(new RegExp(`${token}|${teamId}`));

        send(child, {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "get_project", arguments: {} },
        });
        await waitForId(responses, 8, 20_000, () => stderrBuffer);
        const invalid = responses.get(8) as {
          error?: { code?: number };
          result?: { isError?: boolean; content?: Array<{ text?: string }> };
        };
        if (invalid.error) {
          expect(invalid.error.code).toBe(-32602);
        } else {
          expect(invalid.result?.isError).toBe(true);
          expect(invalid.result?.content?.[0]?.text).toContain("-32602");
        }

        for (const line of stdoutLines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
        expect(stderrBuffer).toContain("vercel-deployment-mcp ready (stdio)");
        expect(stdoutLines.some((line) => line.includes("ready (stdio)"))).toBe(false);
      } finally {
        child.kill();
      }
    },
    20_000,
  );
});
