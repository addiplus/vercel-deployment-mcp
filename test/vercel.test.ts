import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ConfigError,
  buildUrl,
  formatToolError,
  getConfig,
  redactValues,
  vercelGet,
} from "../src/vercel.js";

const TOKEN = "vc_test_token_a1b2c3d4e5";

describe("configuration handling", () => {
  it("requires VERCEL_TOKEN and names the variable in guidance", () => {
    expect(() => getConfig({} as NodeJS.ProcessEnv)).toThrowError(ConfigError);
    try {
      getConfig({} as NodeJS.ProcessEnv);
    } catch (e) {
      expect((e as Error).message).toContain("VERCEL_TOKEN");
    }
  });

  it("reads token and optional team id from the environment", () => {
    const cfg = getConfig({ VERCEL_TOKEN: ` ${TOKEN} `, VERCEL_TEAM_ID: "team_1" } as NodeJS.ProcessEnv);
    expect(cfg.token).toBe(TOKEN);
    expect(cfg.teamId).toBe("team_1");
  });
});

describe("credential values never appear in output", () => {
  it("redactValues removes every occurrence", () => {
    const s = `before ${TOKEN} middle ${TOKEN} after`;
    expect(redactValues(s, [TOKEN])).not.toContain(TOKEN);
  });

  it("API error messages that echo the credential are scrubbed", () => {
    const cfg = { token: TOKEN };
    const err = new ApiError(400, "bad_request", `invalid token: ${TOKEN}`);
    const out = formatToolError(err, cfg);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("HTTP 400");
  });

  it("config errors give guidance without any values", () => {
    const out = formatToolError(new ConfigError("VERCEL_TOKEN is not set. …"), undefined);
    expect(out).toContain("VERCEL_TOKEN");
    expect(out).not.toContain(TOKEN);
  });

  it("unauthorized errors add a hint, still without values", () => {
    const out = formatToolError(new ApiError(401, "forbidden", "Not authorized"), { token: TOKEN });
    expect(out).toContain("credential");
    expect(out).not.toContain(TOKEN);
  });
});

describe("request construction", () => {
  it("buildUrl adds params and teamId, skipping empty values", () => {
    const url = buildUrl("/v9/projects", { search: "shop", limit: 20, empty: "" }, "team_9");
    expect(url).toContain("https://api.vercel.com/v9/projects");
    expect(url).toContain("search=shop");
    expect(url).toContain("limit=20");
    expect(url).toContain("teamId=team_9");
    expect(url).not.toContain("empty=");
  });

  it("vercelGet sends bearer auth and parses JSON", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/v9/projects");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    });
    const data = await vercelGet<{ projects: unknown[] }>(
      { token: TOKEN },
      "/v9/projects",
      {},
      fetchMock as unknown as typeof fetch,
    );
    expect(data.projects).toEqual([]);
  });

  it("non-OK responses become bounded, scrubbed ApiErrors", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "forbidden", message: `denied for ${TOKEN}` } }), {
        status: 403,
      }),
    );
    await expect(
      vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).message).not.toContain(TOKEN);
      return true;
    });
  });
});

describe("size bounds", () => {
  it("bounds a very long API error message to 400 characters", async () => {
    const longMessage = "x".repeat(1000);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "server_error", message: longMessage } }), {
        status: 500,
      }),
    );
    let caught: unknown;
    try {
      await vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message.length).toBeLessThanOrEqual(400);
    const formatted = formatToolError(caught, { token: TOKEN });
    expect(formatted.length).toBeLessThanOrEqual(500);
  });

  it("scrubs the team id from formatToolError, both the API and generic branches", () => {
    const cfg = { token: TOKEN, teamId: "team_secret_xyz9" };
    const apiOut = formatToolError(
      new ApiError(403, "forbidden", "denied for team team_secret_xyz9"),
      cfg,
    );
    expect(apiOut).not.toContain("team_secret_xyz9");

    const genericOut = formatToolError(new Error("boom team_secret_xyz9"), cfg);
    expect(genericOut).not.toContain("team_secret_xyz9");
  });

  it("scrubs the team id at vercelGet, alongside the token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: { code: "forbidden", message: `denied for ${TOKEN} in team team_secret_xyz9` },
        }),
        { status: 403 },
      ),
    );
    await expect(
      vercelGet(
        { token: TOKEN, teamId: "team_secret_xyz9" },
        "/v9/projects",
        {},
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).not.toContain(TOKEN);
      expect((e as ApiError).message).not.toContain("team_secret_xyz9");
      return true;
    });
  });
});
