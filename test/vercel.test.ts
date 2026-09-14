import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ConfigError,
  TRANSPORT_ERROR_PREFIX,
  Throttle,
  assertArrayField,
  assertDeploymentShape,
  assertProjectShape,
  buildUrl,
  formatToolError,
  formatTransportError,
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

  // One configured value is a prefix of the other. Replacing values one at a time leaves
  // the longer one's remainder behind whenever the shorter one goes first, so both list
  // orders are pinned here, and the same has to hold through formatToolError.
  function expectOverlapRedacted(token: string, teamId: string): void {
    const long = token.length >= teamId.length ? token : teamId;
    const short = token.length >= teamId.length ? teamId : token;
    for (const values of [
      [token, teamId],
      [teamId, token],
    ]) {
      const out = redactValues(`saw ${long} here`, values);
      expect(out).toBe("saw [redacted] here");
      expect(out).not.toContain(long.slice(short.length));
      expect(out).not.toContain(short);
    }
    const tool = formatToolError(new ApiError(400, "bad_request", `saw ${long} here`), {
      token,
      teamId,
    });
    expect(tool).toBe("Vercel API error (HTTP 400, bad_request): saw [redacted] here");
    expect(tool).not.toContain(long.slice(short.length));
    expect(tool).not.toContain(short);
  }

  it("redacts overlapping configured values when the team id holds the longer one", () => {
    expectOverlapRedacted("abc", "abcdef");
  });

  it("redacts overlapping configured values when the token holds the longer one", () => {
    expectOverlapRedacted("abcdef", "abc");
  });

  // Two configured values can cross without either one containing the other. A scan that
  // consumes non-overlapping matches takes the first and resumes past its end, which
  // leaves the tail of the second in the text, so both list orders are pinned by exact
  // output on every crossing shape.
  it("redacts crossing configured values, in either list order", () => {
    expect(redactValues("abcd", ["abc", "bcd"])).toBe("[redacted]");
    expect(redactValues("abcd", ["bcd", "abc"])).toBe("[redacted]");
    expect(redactValues("zabcdef", ["zab", "abcdef"])).toBe("[redacted]");
    expect(redactValues("zabcdef", ["abcdef", "zab"])).toBe("[redacted]");
    expect(redactValues("x abcd y", ["abc", "bcd"])).toBe("x [redacted] y");
    expect(redactValues("x abcd y", ["bcd", "abc"])).toBe("x [redacted] y");
  });

  // A value can overlap its own repeats: "aaa" sits at three positions in "aaaaa", and
  // only a scan that advances one character at a time finds the second and the third.
  it("redacts a value that overlaps itself", () => {
    expect(redactValues("aaaaa", ["aaa"])).toBe("[redacted]");
  });

  // Occurrences that only touch are still two occurrences, so they keep one marker each.
  it("keeps adjacent repeats as separate markers", () => {
    expect(redactValues("abcabc", ["abc"])).toBe("[redacted][redacted]");
  });

  // A value that is a substring of "[redacted]" turns a replacement written for the
  // other value into a mangled marker, unless replacement text is never rescanned.
  it("leaves the marker intact when a configured value is a substring of it", () => {
    for (const inner of ["redact", "dact", "ed]"]) {
      const out = redactValues("boom happened", ["boom", inner]);
      expect(out).toBe("[redacted] happened");
      expect(out.match(/\[redacted\]/g)).toHaveLength(1);
      const tool = formatToolError(new ApiError(400, "bad_request", "boom happened"), {
        token: "boom",
        teamId: inner,
      });
      expect(tool).toBe("Vercel API error (HTTP 400, bad_request): [redacted] happened");
      expect(tool.match(/\[redacted\]/g)).toHaveLength(1);
    }
  });

  // The marker is only a literal like any other value: a configured value equal to it maps
  // onto itself, so text that already holds a marker survives unchanged and a real value
  // alongside it still gets its own marker.
  it("maps a configured value equal to the marker onto itself", () => {
    const text = `a [redacted] b ${TOKEN}`;
    expect(redactValues(text, [TOKEN, "[redacted]"])).toBe("a [redacted] b [redacted]");
    expect(redactValues(text, ["[redacted]", TOKEN])).toBe("a [redacted] b [redacted]");
    expect(redactValues("x [redacted] y", ["[redacted]"])).toBe("x [redacted] y");
  });

  // A credential is an opaque string, not a pattern: regex metacharacters in it must
  // match themselves, and must not match anything else.
  it("treats a configured value with regex metacharacters as literal text", () => {
    const value = "a.c+d[e]";
    expect(redactValues(`saw ${value} here`, [value])).toBe("saw [redacted] here");
    expect(redactValues("saw aXccde here", [value])).toBe("saw aXccde here");
    expect(
      formatToolError(new ApiError(400, "bad_request", "saw aXccde here"), { token: value }),
    ).toBe("Vercel API error (HTTP 400, bad_request): saw aXccde here");
  });

  it("ignores undefined and empty configured values", () => {
    expect(redactValues("nothing here to hide", [undefined, ""])).toBe("nothing here to hide");
    expect(redactValues(`saw ${TOKEN} here`, [undefined, "", TOKEN])).toBe("saw [redacted] here");
  });

  it("redacts a value listed twice, leaving a single marker", () => {
    const out = redactValues(`saw ${TOKEN} here`, [TOKEN, TOKEN]);
    expect(out).toBe("saw [redacted] here");
    expect(out.match(/\[redacted\]/g)).toHaveLength(1);
  });

  // Matching is literal and happens in one pass, so a long credential costs one scan of
  // the text rather than a fresh attempt at every starting position.
  it("redacts a very long configured value promptly", () => {
    const long = "z".repeat(20000);
    const out = redactValues(`saw ${long} here`, [long, long.slice(0, 10000)]);
    expect(out).toBe("saw [redacted] here");
  });

  // Bounds: a large body holding many occurrences of a realistic-length value, and a long
  // run that one short value overlaps itself across, both resolve to exact output.
  it("redacts many occurrences spread through a large text", () => {
    const value = "v".repeat(40);
    const filler = "-".repeat(20000);
    const text = Array.from({ length: 50 }, () => filler + value).join("") + filler;
    const expected = Array.from({ length: 50 }, () => filler + "[redacted]").join("") + filler;
    expect(redactValues(text, [value])).toBe(expected);
  });

  it("collapses a long self-overlapping run into a single marker", () => {
    expect(redactValues("a".repeat(20000), ["aaa"])).toBe("[redacted]");
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

describe("formatTransportError", () => {
  const ENV = { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: "team_secret_xyz9" } as NodeJS.ProcessEnv;

  it("redacts the configured token and team id out of the message", () => {
    const out = formatTransportError(
      new Error(`transport blew up on ${TOKEN} for team_secret_xyz9`),
      ENV,
    );
    expect(out).toBe(
      `${TRANSPORT_ERROR_PREFIX}transport blew up on [redacted] for [redacted]`,
    );
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("team_secret_xyz9");
  });

  it("reads the environment at call time, and trims it the way getConfig does", () => {
    const message = new Error(`boom ${TOKEN}`);
    expect(formatTransportError(message, {})).toContain(TOKEN);
    expect(formatTransportError(message, { VERCEL_TOKEN: ` ${TOKEN} ` })).toBe(
      `${TRANSPORT_ERROR_PREFIX}boom [redacted]`,
    );
  });

  it("collapses every kind of whitespace to one line", () => {
    const out = formatTransportError(new Error("line one\nline two\r\n\tline three"), ENV);
    expect(out).toBe(`${TRANSPORT_ERROR_PREFIX}line one line two line three`);
    expect(out).not.toMatch(/[\r\n\t]/);
  });

  it("never throws, whatever the transport hands it", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      "a raw string throw",
      { a: 1 },
      Symbol("s"),
      { toString() { throw new Error("nope"); } },
      new Error(""),
      new Error("   \n  "),
      Object.assign(new Error("x"), { message: 7 }),
    ];
    for (const input of hostile) {
      let out = "";
      expect(() => { out = formatTransportError(input, ENV); }).not.toThrow();
      expect(out.startsWith(TRANSPORT_ERROR_PREFIX)).toBe(true);
      expect(out).not.toMatch(/[\r\n]/);
    }
    expect(formatTransportError(new Error(""), ENV)).toBe(
      `${TRANSPORT_ERROR_PREFIX}unknown transport error`,
    );
  });

  // A configured value may carry internal whitespace: getConfig only trims the ends.
  // Redaction therefore has to run on the raw text; collapsing first rewrites the
  // value's own bytes and the exact-value replacement then finds nothing to replace.
  it("redacts a configured value that contains whitespace, on the transport path", () => {
    const spaced = "secret  token";
    expect(formatTransportError(new Error(`echo ${spaced} B`), { VERCEL_TOKEN: spaced })).toBe(
      `${TRANSPORT_ERROR_PREFIX}echo [redacted] B`,
    );
    const tabbed = "secret\ttoken";
    expect(formatTransportError(new Error(`echo ${tabbed} B`), { VERCEL_TEAM_ID: tabbed })).toBe(
      `${TRANSPORT_ERROR_PREFIX}echo [redacted] B`,
    );
    const wrapped = "secret\nvalue";
    expect(formatTransportError(new Error(`echo ${wrapped} B`), { VERCEL_TOKEN: wrapped })).toBe(
      `${TRANSPORT_ERROR_PREFIX}echo [redacted] B`,
    );
    // The collapse still happens, it just happens second.
    const both = formatTransportError(new Error(`a\n\nb ${spaced} c`), { VERCEL_TOKEN: spaced });
    expect(both).toBe(`${TRANSPORT_ERROR_PREFIX}a b [redacted] c`);
    expect(both).not.toMatch(/[\r\n\t]/);
  });

  // One configured value is a prefix of the other. Replacing values one at a time leaves
  // the longer one's remainder behind whenever the shorter one goes first, so each field
  // order is pinned on its own, on both the transport path and the tool path.
  function expectOverlapRedacted(token: string, teamId: string): void {
    const long = token.length >= teamId.length ? token : teamId;
    const short = token.length >= teamId.length ? teamId : token;
    const transport = formatTransportError(new Error(`saw ${long} here`), {
      VERCEL_TOKEN: token,
      VERCEL_TEAM_ID: teamId,
    } as NodeJS.ProcessEnv);
    expect(transport).toBe(`${TRANSPORT_ERROR_PREFIX}saw [redacted] here`);
    expect(transport).not.toContain(long.slice(short.length));
    expect(transport).not.toContain(short);
    // formatToolError shares the same helper, so the same has to hold there.
    const tool = formatToolError(new ApiError(400, "bad_request", `saw ${long} here`), {
      token,
      teamId,
    });
    expect(tool).toBe("Vercel API error (HTTP 400, bad_request): saw [redacted] here");
    expect(tool).not.toContain(long.slice(short.length));
    expect(tool).not.toContain(short);
  }

  it("redacts overlapping configured values when the team id holds the longer one", () => {
    expectOverlapRedacted("abc", "abcdef");
  });

  it("redacts overlapping configured values when the token holds the longer one", () => {
    expectOverlapRedacted("abcdef", "abc");
  });

  // Crossing values, where neither one contains the other: "abc" and "bcd" both sit in
  // "abcd", and the reported line must hold one marker and none of either value.
  it("redacts crossing configured values on the transport path", () => {
    const out = formatTransportError(new Error("denied abcd"), {
      VERCEL_TOKEN: "abc",
      VERCEL_TEAM_ID: "bcd",
    } as NodeJS.ProcessEnv);
    expect(out).toBe(`${TRANSPORT_ERROR_PREFIX}denied [redacted]`);
    expect(out.match(/\[redacted\]/g)).toHaveLength(1);
    expect(out).not.toContain("abcd");
    expect(out).not.toContain("[redacted]d");
  });

  // A value that is a substring of "[redacted]" turns a replacement written for the
  // other value into a mangled marker, unless replacement text is never rescanned.
  it("leaves the marker intact when a configured value is a substring of it", () => {
    for (const inner of ["redact", "dact", "ed]"]) {
      const env = { VERCEL_TOKEN: "boom", VERCEL_TEAM_ID: inner } as NodeJS.ProcessEnv;
      const out = formatTransportError(new Error("boom happened"), env);
      expect(out).toBe(`${TRANSPORT_ERROR_PREFIX}[redacted] happened`);
      expect(out.match(/\[redacted\]/g)).toHaveLength(1);
      const tool = formatToolError(new ApiError(400, "bad_request", "boom happened"), {
        token: "boom",
        teamId: inner,
      });
      expect(tool).toBe("Vercel API error (HTTP 400, bad_request): [redacted] happened");
      expect(tool.match(/\[redacted\]/g)).toHaveLength(1);
    }
  });

  // A credential is an opaque string, not a pattern: regex metacharacters in it must
  // match themselves, and must not match anything else.
  it("treats a configured value with regex metacharacters as literal text", () => {
    const env = { VERCEL_TOKEN: "a.c+d[e]" } as NodeJS.ProcessEnv;
    expect(formatTransportError(new Error("saw a.c+d[e] here"), env)).toBe(
      `${TRANSPORT_ERROR_PREFIX}saw [redacted] here`,
    );
    expect(formatTransportError(new Error("saw abcXdZ here"), env)).toBe(
      `${TRANSPORT_ERROR_PREFIX}saw abcXdZ here`,
    );
  });

  it("caps the transport message at its own 400 characters", () => {
    const out = formatTransportError(new Error("x".repeat(900)), ENV);
    expect(out).toHaveLength(TRANSPORT_ERROR_PREFIX.length + 400);
    expect(out.endsWith("x")).toBe(true);
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

  it("non-OK responses become ApiErrors carrying the upstream status and code", async () => {
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
      expect((e as ApiError).code).toBe("forbidden");
      expect(formatToolError(e, { token: TOKEN })).not.toContain(TOKEN);
      return true;
    });
  });
});

describe("size bounds", () => {
  it("bounds client-visible error text to 500 characters", async () => {
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

  it("scrubs the token and the team id from the formatted error", async () => {
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
      const formatted = formatToolError(e, { token: TOKEN, teamId: "team_secret_xyz9" });
      expect(formatted).not.toContain(TOKEN);
      expect(formatted).not.toContain("team_secret_xyz9");
      return true;
    });
  });

  // The API client hands its configured values to the scrubber as [token, teamId], so the
  // list order is fixed and only which value contains the other can vary. Both directions
  // are pinned here, on the path that actually carries upstream text back to a client.
  it("scrubs overlapping configured values in the formatted error when the team id holds the token", async () => {
    const token = "abc123";
    const teamId = "team_abc123xyz";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "forbidden", message: `denied for ${teamId}` } }),
        { status: 403 },
      ),
    );
    await expect(
      vercelGet({ token, teamId }, "/v9/projects", {}, fetchMock as unknown as typeof fetch),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      const formatted = formatToolError(e, { token, teamId });
      expect(formatted).toContain("[redacted]");
      expect(formatted).not.toContain(token);
      expect(formatted).not.toContain(teamId);
      expect(formatted).not.toContain("xyz");
      return true;
    });
  });

  it("scrubs overlapping configured values in the formatted error when the token holds the team id", async () => {
    const token = "vc_abc123xyz";
    const teamId = "abc123";
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "forbidden", message: `denied for ${token}` } }),
        { status: 403 },
      ),
    );
    await expect(
      vercelGet({ token, teamId }, "/v9/projects", {}, fetchMock as unknown as typeof fetch),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      const formatted = formatToolError(e, { token, teamId });
      expect(formatted).toContain("[redacted]");
      expect(formatted).not.toContain(token);
      expect(formatted).not.toContain(teamId);
      expect(formatted).not.toContain("xyz");
      return true;
    });
  });

  // Crossing values on the path that actually carries upstream text back to a client:
  // "abc" and "bcd" both sit in "abcd" without either one containing the other.
  it("scrubs crossing configured values in the formatted error", async () => {
    const token = "abc";
    const teamId = "bcd";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "forbidden", message: "denied abcd" } }), {
        status: 403,
      }),
    );
    let caught: unknown;
    try {
      await vercelGet({ token, teamId }, "/v9/projects", {}, fetchMock as unknown as typeof fetch);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(formatToolError(caught, { token, teamId })).toBe(
      "Vercel API error (HTTP 403, forbidden): denied [redacted]. Check that the configured " +
        "credential is valid and has access to this project or team.",
    );
  });

  it("leaves the redaction marker intact when a configured value is a substring of it", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "internal_server_error", message: "internal_server_error" } }),
        { status: 500 },
      ),
    );
    let caught: unknown;
    try {
      await vercelGet({ token: "a" }, "/v9/projects", {}, fetchMock as unknown as typeof fetch);
    } catch (e) {
      caught = e;
    }
    const formatted = formatToolError(caught, { token: "a" });
    expect(formatted).toContain("[redacted]");
    expect(formatted).not.toContain("[red[redacted]cted]");
  });

  it("replaces a configured value that straddles the length cut", async () => {
    const straddler = "STRADDLE_CANARY_0123456789";
    const message = `${"y".repeat(450)}${straddler}${"z".repeat(50)}`;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "server_error", message } }), { status: 500 }),
    );
    let caught: unknown;
    try {
      await vercelGet({ token: straddler }, "/v9/projects", {}, fetchMock as unknown as typeof fetch);
    } catch (e) {
      caught = e;
    }
    const formatted = formatToolError(caught, { token: straddler });
    expect(formatted.length).toBe(500);
    expect(formatted).not.toContain("STRADDLE");
  });

  it("keeps the whole credential hint on an upstream message that fills the bound", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "forbidden", message: "M".repeat(600) } }), {
        status: 403,
      }),
    );
    let caught: unknown;
    try {
      await vercelGet({ token: TOKEN }, "/v9/projects", {}, fetchMock as unknown as typeof fetch);
    } catch (e) {
      caught = e;
    }
    const formatted = formatToolError(caught, { token: TOKEN });
    expect(formatted.length).toBeLessThanOrEqual(500);
    expect(formatted).toContain("MMMM");
    // The cut text still ends as a sentence, so the hint reads as its own.
    expect(formatted).toContain("M. Check that");
    expect(formatted.endsWith(
      " Check that the configured credential is valid and has access to this project or team.",
    )).toBe(true);
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

  it("caps a minimum interval above the ceiling and says so on stderr", () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const options = resolveThrottleOptions({
        VERCEL_MCP_MIN_INTERVAL_MS: "1e9",
      } as NodeJS.ProcessEnv);
      expect(options.minIntervalMs).toBe(60_000);
      expect(reported).toHaveBeenCalledTimes(1);
      const line = String(reported.mock.calls[0][0]);
      expect(line).toContain("VERCEL_MCP_MIN_INTERVAL_MS");
      expect(line).toContain("60000");
    } finally {
      reported.mockRestore();
    }
  });

  it("leaves a value at the ceiling alone and stays quiet", () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        resolveThrottleOptions({ VERCEL_MCP_MIN_INTERVAL_MS: "60000" } as NodeJS.ProcessEnv)
          .minIntervalMs,
      ).toBe(60_000);
      expect(reported).not.toHaveBeenCalled();
    } finally {
      reported.mockRestore();
    }
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
    clock += 20; // well within the 100ms interval, so the next run() must wait 80ms
    await throttle.run(async () => {
      starts.push(clock);
    });
    clock += 200; // already past the interval, no wait needed
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

  it("assertDeploymentShape accepts an object with or without a string identifier", () => {
    expect(() => assertDeploymentShape({ uid: "dpl_1" })).not.toThrow();
    expect(() => assertDeploymentShape({ id: "dpl_1" })).not.toThrow();
    expect(() => assertDeploymentShape({ name: "app" })).not.toThrow();
    expect(() => assertDeploymentShape({ uid: 42, id: "dpl_1" })).toThrowError(ApiError);
    expect(() => assertDeploymentShape({ id: 42 })).toThrowError(ApiError);
    expect(() => assertDeploymentShape({ uid: null })).toThrowError(ApiError);
    expect(() => assertDeploymentShape({ uid: "dpl_1", id: 42 })).toThrowError(ApiError);
    expect(() => assertDeploymentShape(null)).toThrowError(ApiError);
    expect(() => assertDeploymentShape([])).toThrowError(ApiError);
    expect(() => assertDeploymentShape("dpl_1")).toThrowError(ApiError);
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
      expect(formatToolError(e, { token: TOKEN })).not.toContain(TOKEN);
      return true;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
