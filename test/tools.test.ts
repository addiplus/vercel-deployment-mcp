import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";

const TOKEN = "vc_test_token_a1b2c3d4e5";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  meta: unknown;
  handler: ToolHandler;
}

/** Records registerTool calls instead of talking to a real MCP transport. */
class FakeServer {
  tools = new Map<string, RegisteredTool>();
  registerTool(name: string, meta: unknown, handler: ToolHandler): void {
    this.tools.set(name, { name, meta, handler });
  }
}

function getTools(): Map<string, RegisteredTool> {
  const fake = new FakeServer();
  registerTools(fake as unknown as McpServer);
  return fake.tools;
}

let savedToken: string | undefined;
let savedTeamId: string | undefined;

beforeEach(() => {
  savedToken = process.env.VERCEL_TOKEN;
  savedTeamId = process.env.VERCEL_TEAM_ID;
  process.env.VERCEL_TOKEN = TOKEN;
  delete process.env.VERCEL_TEAM_ID;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = savedToken;
  if (savedTeamId === undefined) delete process.env.VERCEL_TEAM_ID;
  else process.env.VERCEL_TEAM_ID = savedTeamId;
  vi.unstubAllGlobals();
});

describe("tool registration", () => {
  it("registers exactly the four documented tools", () => {
    const tools = getTools();
    const names = [...tools.keys()];
    expect(new Set(names)).toEqual(
      new Set(["list_projects", "get_project", "list_deployments", "get_deployment"]),
    );
    expect(names.length).toBe(4);
  });
});

describe("read-only requests", () => {
  const documentedParams: Record<string, string[]> = {
    list_projects: ["search", "limit", "teamId"],
    get_project: ["teamId"],
    list_deployments: ["projectId", "state", "limit", "teamId"],
    get_deployment: ["teamId"],
  };

  const validInputs: Record<string, Record<string, unknown>> = {
    list_projects: { search: "demo", limit: 5 },
    get_project: { idOrName: "prj_demo" },
    list_deployments: { projectId: "prj_demo", state: "READY", limit: 5 },
    get_deployment: { idOrUrl: "dpl_demo" },
  };

  it("issues GET requests with no body, using only documented query params", async () => {
    const tools = getTools();
    for (const [name, allowed] of Object.entries(documentedParams)) {
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method === undefined || init?.method === "GET").toBe(true);
        expect(init?.body).toBeUndefined();
        const requestUrl = new URL(String(url));
        for (const key of requestUrl.searchParams.keys()) {
          expect(allowed).toContain(key);
        }
        return new Response(
          JSON.stringify({
            id: "id_1",
            name: "name_1",
            framework: null,
            updatedAt: 1700000000000,
            url: "app.vercel.app",
            state: "READY",
            target: "production",
            createdAt: 1700000000000,
            projects: [],
            deployments: [],
          }),
          { status: 200 },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      await tool.handler(validInputs[name]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe("projection-only responses", () => {
  it("list_projects drops fields outside the documented projection", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          projects: [
            {
              id: "prj_1",
              name: "demo",
              framework: "nextjs",
              updatedAt: 1700000000000,
              env: "secret",
              accountId: "acc_1",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await tools.get("list_projects")!.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed).sort()).toEqual(["count", "projects"]);
    const row = parsed.projects[0];
    expect(Object.keys(row).sort()).toEqual(["framework", "id", "name", "updatedAt"]);
    expect(row.env).toBeUndefined();
    expect(row.accountId).toBeUndefined();
  });

  it("list_deployments drops fields outside the documented projection", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          deployments: [
            {
              uid: "dpl_1",
              name: "app",
              url: "app.vercel.app",
              state: "READY",
              readyState: "READY",
              target: "production",
              createdAt: 1700000000000,
              creator: { uid: "usr_1" },
              alias: ["app.example.com"],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await tools.get("list_deployments")!.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed).sort()).toEqual(["count", "deployments"]);
    const row = parsed.deployments[0];
    expect(Object.keys(row).sort()).toEqual(["createdAt", "id", "name", "state", "target", "url"]);
    expect(row.creator).toBeUndefined();
    expect(row.alias).toBeUndefined();
  });

  it("get_project drops fields outside the documented projection", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "prj_1",
          name: "demo",
          framework: "nextjs",
          updatedAt: 1700000000000,
          env: "secret",
          accountId: "acc_1",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await tools.get("get_project")!.handler({ idOrName: "prj_1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed).sort()).toEqual(["framework", "id", "name", "updatedAt"]);
    expect(parsed.env).toBeUndefined();
    expect(parsed.accountId).toBeUndefined();
  });

  it("get_deployment drops fields outside the documented projection", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          uid: "dpl_1",
          name: "app",
          url: "app.vercel.app",
          state: "READY",
          readyState: "READY",
          target: "production",
          createdAt: 1700000000000,
          creator: { uid: "usr_1" },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await tools.get("get_deployment")!.handler({ idOrUrl: "dpl_1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed).sort()).toEqual(["createdAt", "id", "name", "state", "target", "url"]);
    expect(parsed.creator).toBeUndefined();
  });
});

describe("default limit", () => {
  it("list_projects defaults limit to 20 when omitted", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.searchParams.get("limit")).toBe("20");
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await tools.get("list_projects")!.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("list_deployments defaults limit to 20 when omitted", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.searchParams.get("limit")).toBe("20");
      return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await tools.get("list_deployments")!.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("error path shape", () => {
  it("surfaces a bounded, scrubbed error for HTTP failures", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "forbidden", message: `denied for ${TOKEN}` } }),
        { status: 403 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await tools.get("list_projects")!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("HTTP 403");
    expect(result.content[0].text).toContain("credential");
    expect(result.content[0].text).not.toContain(TOKEN);
  });
});

describe("stateless by design", () => {
  it("re-reads configuration from the environment on every call", async () => {
    const tools = getTools();
    const captured: string[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    process.env.VERCEL_TOKEN = "vc_test_first";
    await tools.get("list_projects")!.handler({});

    process.env.VERCEL_TOKEN = "vc_test_second";
    await tools.get("list_projects")!.handler({});

    expect(captured).toEqual(["Bearer vc_test_first", "Bearer vc_test_second"]);
  });
});

describe("missing configuration", () => {
  it("reports a configuration problem naming VERCEL_TOKEN", async () => {
    const tools = getTools();
    delete process.env.VERCEL_TOKEN;
    const result = await tools.get("list_projects")!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("VERCEL_TOKEN");
    expect(result.content[0].text).toContain("Configuration problem");
  });
});
