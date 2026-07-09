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
    process.env.VERCEL_TEAM_ID = "team_secret_xyz9";
    const tools = getTools();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "forbidden",
            message: `denied for ${TOKEN} in team team_secret_xyz9`,
          },
        }),
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
    expect(result.content[0].text).not.toContain("team_secret_xyz9");
  });
});

describe("concurrency isolation", () => {
  it("keeps concurrent list_projects calls from crossing results", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s.includes("search=alpha")) {
        return new Response(JSON.stringify({ projects: [{ id: "a1", name: "alpha" }] }), {
          status: 200,
        });
      }
      if (s.includes("search=beta")) {
        return new Response(JSON.stringify({ projects: [{ id: "b1", name: "beta" }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected request: ${s}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = tools.get("list_projects")!.handler;
    const [alphaResult, betaResult] = await Promise.all([
      handler({ search: "alpha" }),
      handler({ search: "beta" }),
    ]);
    const alphaParsed = JSON.parse(alphaResult.content[0].text);
    const betaParsed = JSON.parse(betaResult.content[0].text);
    expect(alphaParsed.projects).toEqual([{ id: "a1", name: "alpha", framework: null }]);
    expect(betaParsed.projects).toEqual([{ id: "b1", name: "beta", framework: null }]);
  });
});

describe("URL path encoding", () => {
  it("percent-encodes idOrName and idOrUrl path segments", async () => {
    const tools = getTools();

    let projectUrl = "";
    const projectFetch = vi.fn(async (url: RequestInfo | URL) => {
      projectUrl = String(url);
      return new Response(JSON.stringify({ id: "prj_1", name: "demo" }), { status: 200 });
    });
    vi.stubGlobal("fetch", projectFetch);
    await tools.get("get_project")!.handler({ idOrName: "my proj/x" });
    expect(projectUrl).toContain("/v9/projects/my%20proj%2Fx");

    let deploymentUrl = "";
    const deploymentFetch = vi.fn(async (url: RequestInfo | URL) => {
      deploymentUrl = String(url);
      return new Response(JSON.stringify({ id: "dpl_1", name: "app" }), { status: 200 });
    });
    vi.stubGlobal("fetch", deploymentFetch);
    await tools.get("get_deployment")!.handler({ idOrUrl: "dpl/one two" });
    expect(deploymentUrl).toContain("/v13/deployments/dpl%2Fone%20two");
  });
});

describe("state fallback", () => {
  it("falls back to readyState when state is absent", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          uid: "dpl_1",
          name: "app",
          url: "app.vercel.app",
          readyState: "READY",
          target: "production",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await tools.get("get_deployment")!.handler({ idOrUrl: "dpl_1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.state).toBe("READY");
  });
});

describe("compact JSON format", () => {
  it("round-trips the returned text through JSON.stringify(…, null, 2)", async () => {
    const tools = getTools();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ projects: [{ id: "prj_1", name: "demo" }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await tools.get("list_projects")!.handler({});
    const text = result.content[0].text;
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
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
