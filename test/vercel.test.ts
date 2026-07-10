import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ConfigError,
  Throttle,
  assertArrayField,
  assertDeploymentShape,
  assertProjectShape,
  buildUrl,
  formatToolError,
  getConfig,
  redactValues,
  resolveThrottleOptions,
  vercelGet,
} from "../src/vercel.js";

const TOKEN = "vc_test_token_a1b2c3d4e5";

// vercelGet falls back to a lazily-created, module-level default Throttle when no throttle
// is injected. Disable its spacing here so tests that don't care about throttling (most of
// this file) never wait on a real timer.
process.env.VERCEL_MCP_MIN_INTERVAL_MS = "0";

/** A Throttle whose sleep is a spy instead of a real timer, for retry/spacing assertions. */
function fakeThrottle(options: { minIntervalMs?: number; maxConcurrent?: number } = {}) {
  const delays: number[] = [];
  const throttle = new Throttle(
    { minIntervalMs: options.minIntervalMs ?? 0, maxConcurrent: options.maxConcurrent ?? 4 },
    { sleep: async (ms) => { delays.push(ms); } },
  );
  return { throttle, delays };
}

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

describe("additional failure paths", () => {
  it("rate-limited errors add a retry hint, still without values", () => {
    const out = formatToolError(new ApiError(429, "rate_limited", "slow down"), { token: TOKEN });
    expect(out).toContain("Rate limited");
    expect(out).toContain("retry");
    expect(out).not.toContain(TOKEN);
  });

  it("network rejections become a generic ApiError, discarding the raw error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("socket hang up: " + TOKEN);
    });
    await expect(
      vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("network_error");
      expect((e as ApiError).message).toBe("Network error reaching the Vercel API.");
      return true;
    });
  });

  it("timeouts are shaped into a dedicated ApiError", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(
      vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("timeout");
      expect((e as ApiError).message).toContain("timed out");
      return true;
    });
  });

  it("wires an AbortSignal timeout into every request", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    });
    await vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch);
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("non-JSON error bodies fall back to the generic HTTP status message", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>oops</html>", { status: 500 }));
    await expect(
      vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe("Vercel API responded with HTTP 500.");
      return true;
    });
  });

  it("non-Error throws hit the hardcoded fallback message, leaking nothing", () => {
    const out = formatToolError("raw string throw", { token: TOKEN, teamId: "team_secret_xyz9" });
    expect(out).toBe("Unexpected error.");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("team_secret_xyz9");
  });

  it("separates the upstream message from an appended hint with a period", () => {
    const out = formatToolError(new ApiError(401, "forbidden", "Not authorized"), { token: TOKEN });
    expect(out).toContain("Not authorized. Check");
    const already = formatToolError(new ApiError(401, "forbidden", "Not authorized."), { token: TOKEN });
    expect(already).toContain("Not authorized. Check");
    expect(already).not.toContain("Not authorized.. Check");
  });
});

describe("resolveThrottleOptions", () => {
  it("uses the documented defaults when both env vars are absent", () => {
    expect(resolveThrottleOptions({} as NodeJS.ProcessEnv)).toEqual({
      minIntervalMs: 250,
      maxConcurrent: 4,
    });
  });

  it("parses valid overrides", () => {
    expect(
      resolveThrottleOptions({
        VERCEL_MCP_MIN_INTERVAL_MS: "500",
        VERCEL_MCP_MAX_CONCURRENT: "2",
      } as NodeJS.ProcessEnv),
    ).toEqual({ minIntervalMs: 500, maxConcurrent: 2 });
  });

  it("falls back to defaults for non-numeric values, never throwing", () => {
    expect(() =>
      resolveThrottleOptions({
        VERCEL_MCP_MIN_INTERVAL_MS: "soon",
        VERCEL_MCP_MAX_CONCURRENT: "many",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(
      resolveThrottleOptions({
        VERCEL_MCP_MIN_INTERVAL_MS: "soon",
        VERCEL_MCP_MAX_CONCURRENT: "many",
      } as NodeJS.ProcessEnv),
    ).toEqual({ minIntervalMs: 250, maxConcurrent: 4 });
  });

  it("falls back to defaults for negative values", () => {
    expect(
      resolveThrottleOptions({
        VERCEL_MCP_MIN_INTERVAL_MS: "-10",
        VERCEL_MCP_MAX_CONCURRENT: "-1",
      } as NodeJS.ProcessEnv),
    ).toEqual({ minIntervalMs: 250, maxConcurrent: 4 });
  });

  it("falls back to defaults for a blank string", () => {
    expect(
      resolveThrottleOptions({ VERCEL_MCP_MIN_INTERVAL_MS: "  " } as NodeJS.ProcessEnv),
    ).toEqual({ minIntervalMs: 250, maxConcurrent: 4 });
  });

  it("allows a zero minIntervalMs, which disables spacing", () => {
    expect(
      resolveThrottleOptions({ VERCEL_MCP_MIN_INTERVAL_MS: "0" } as NodeJS.ProcessEnv).minIntervalMs,
    ).toBe(0);
  });

  it("floors maxConcurrent at 1 instead of falling back to the default", () => {
    expect(
      resolveThrottleOptions({ VERCEL_MCP_MAX_CONCURRENT: "0" } as NodeJS.ProcessEnv).maxConcurrent,
    ).toBe(1);
  });
});

describe("Throttle", () => {
  it("honors the minimum start-to-start interval using an injected fake clock", async () => {
    let clock = 0;
    const sleepCalls: number[] = [];
    const throttle = new Throttle(
      { minIntervalMs: 100, maxConcurrent: 4 },
      {
        now: () => clock,
        sleep: async (ms) => {
          sleepCalls.push(ms);
          clock += ms;
        },
      },
    );
    const starts: number[] = [];
    await throttle.run(async () => {
      starts.push(clock);
    });
    clock += 20; // well within the 100ms interval — the next run() must wait 80ms
    await throttle.run(async () => {
      starts.push(clock);
    });
    clock += 200; // already past the interval — no wait needed
    await throttle.run(async () => {
      starts.push(clock);
    });
    expect(starts).toEqual([0, 100, 300]);
    expect(sleepCalls).toEqual([80]);
  });

  it("caps the number of concurrently running tasks", async () => {
    const throttle = new Throttle({ minIntervalMs: 0, maxConcurrent: 2 }, { sleep: async () => {} });
    let active = 0;
    let maxActive = 0;
    const started = [0, 1, 2].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve, seen: false };
    });
    started.forEach((s) => {
      s.promise.then(() => {
        s.seen = true;
      });
    });
    const gates = [0, 1, 2].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    });

    const runTask = (i: number) =>
      throttle.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        started[i].resolve();
        await gates[i].promise;
        active--;
      });

    const results = [runTask(0), runTask(1), runTask(2)];

    await Promise.all([started[0].promise, started[1].promise]);
    // The third task cannot have started yet: nothing has freed a slot for it.
    expect(started[2].seen).toBe(false);
    expect(active).toBe(2);

    gates[0].resolve();
    await started[2].promise;
    expect(active).toBeLessThanOrEqual(2);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(results);
    expect(maxActive).toBe(2);
  });
});

describe("shape guards for otherwise-parsed 2xx bodies", () => {
  it("assertArrayField allows an absent field but rejects a present non-array", () => {
    expect(() => assertArrayField({}, "projects")).not.toThrow();
    expect(() => assertArrayField({ projects: [] }, "projects")).not.toThrow();
    expect(() => assertArrayField({ projects: "nope" }, "projects")).toThrowError(ApiError);
  });

  it("assertArrayField rejects a body that is not an object at all", () => {
    expect(() => assertArrayField(null as never, "projects")).toThrowError(ApiError);
    expect(() => assertArrayField("nope" as never, "projects")).toThrowError(ApiError);
  });

  it("assertProjectShape requires a non-null object with string id and name", () => {
    expect(() => assertProjectShape({ id: "prj_1", name: "demo" })).not.toThrow();
    expect(() => assertProjectShape({ id: "prj_1" })).toThrowError(ApiError);
    expect(() => assertProjectShape({ id: 1, name: "demo" })).toThrowError(ApiError);
    expect(() => assertProjectShape(null)).toThrowError(ApiError);
    expect(() => assertProjectShape("prj_1")).toThrowError(ApiError);
  });

  it("assertDeploymentShape accepts either uid or id as the string identifier", () => {
    expect(() => assertDeploymentShape({ uid: "dpl_1" })).not.toThrow();
    expect(() => assertDeploymentShape({ id: "dpl_1" })).not.toThrow();
    expect(() => assertDeploymentShape({ name: "app" })).toThrowError(ApiError);
    expect(() => assertDeploymentShape(null)).toThrowError(ApiError);
  });
});

describe("429 Retry-After handling in vercelGet", () => {
  it("retries exactly once when Retry-After is small and numeric, then succeeds", async () => {
    const { throttle, delays } = fakeThrottle();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }),
          { status: 429, headers: { "Retry-After": "1" } },
        );
      }
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    });
    const data = await vercelGet<{ projects: unknown[] }>(
      { token: TOKEN },
      "/v9/projects",
      {},
      fetchMock as unknown as typeof fetch,
      throttle,
    );
    expect(data.projects).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]);
  });

  it("does not retry when Retry-After is absent", async () => {
    const { throttle, delays } = fakeThrottle();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), {
        status: 429,
      }),
    );
    await expect(
      vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch, throttle),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("does not retry when Retry-After exceeds 10 seconds", async () => {
    const { throttle, delays } = fakeThrottle();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), {
        status: 429,
        headers: { "Retry-After": "99" },
      }),
    );
    await expect(
      vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch, throttle),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("does not retry on an HTTP-date Retry-After (non-numeric)", async () => {
    const { throttle, delays } = fakeThrottle();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), {
        status: 429,
        headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }),
    );
    await expect(
      vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch, throttle),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("a second 429 after the retry surfaces like any other error, without leaking the token", async () => {
    const { throttle } = fakeThrottle();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "rate_limited", message: `still busy for ${TOKEN}` } }),
        { status: 429, headers: { "Retry-After": "1" } },
      ),
    );
    await expect(
      vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch, throttle),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(429);
      expect((e as ApiError).message).not.toContain(TOKEN);
      return true;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
