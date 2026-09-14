/**
 * Vercel REST API client with strict configuration hygiene.
 *
 * Design principles (verified in test/):
 *  - Credential values are read only from the environment and never echoed:
 *    not in errors, not in logs, not in tool responses.
 *  - stdout belongs to the MCP protocol; diagnostics go to stderr only.
 *  - Errors surfaced to the client are shaped and size-bounded.
 */

const API_BASE = "https://api.vercel.com";

export interface VercelConfig {
  token: string;
  teamId?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Read configuration from the environment. Values are never logged. */
export function getConfig(env: NodeJS.ProcessEnv = process.env): VercelConfig {
  const token = env.VERCEL_TOKEN?.trim();
  if (!token) {
    throw new ConfigError(
      "VERCEL_TOKEN is not set. Create a token in your Vercel account settings " +
        "and provide it via the VERCEL_TOKEN environment variable. " +
        "Optionally set VERCEL_TEAM_ID to scope requests to a team.",
    );
  }
  const teamId = env.VERCEL_TEAM_ID?.trim() || undefined;
  return { token, teamId };
}

/**
 * Replace any occurrence of the given values in text with a placeholder.
 *
 * Every distinct value is replaced in one left-to-right pass, longest first, so
 * that no replacement text is ever rescanned. Replacing values one after the
 * other is wrong twice over: with overlapping values the shorter one goes first
 * and leaves the longer one's remainder behind, and a value that is a substring
 * of the placeholder chops up a placeholder an earlier value already wrote.
 */
export function redactValues(text: string, values: Array<string | undefined>): string {
  const present = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  const needles = [...new Set(present)].sort((a, b) => b.length - a.length);
  if (needles.length === 0) return text;
  const pattern = needles.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return text.replace(new RegExp(pattern, "g"), "[redacted]");
}

/** Build a request URL, adding teamId when configured. */
export function buildUrl(
  path: string,
  params: Record<string, string | number | undefined>,
  teamId?: string,
): string {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  if (teamId) url.searchParams.set("teamId", teamId);
  return url.toString();
}

const MAX_ERROR_LEN = 400;
const REQUEST_TIMEOUT_MS = 30_000;

/** Politeness throttle applied to every outbound Vercel API request. */
export interface ThrottleOptions {
  minIntervalMs: number;
  maxConcurrent: number;
}

const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_MAX_CONCURRENT = 4;
const MAX_AUTO_RETRY_AFTER_SECONDS = 10;

/** A finite, non-negative number parsed from a trimmed env var, or undefined if unusable. */
function parseFiniteNonNegative(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/** Parse throttle env vars defensively: bad input falls back to defaults, never throws. */
export function resolveThrottleOptions(env: NodeJS.ProcessEnv = process.env): ThrottleOptions {
  const parsedMinInterval = parseFiniteNonNegative(env.VERCEL_MCP_MIN_INTERVAL_MS);
  const minIntervalMs =
    parsedMinInterval !== undefined ? Math.floor(parsedMinInterval) : DEFAULT_MIN_INTERVAL_MS;

  const parsedMaxConcurrent = parseFiniteNonNegative(env.VERCEL_MCP_MAX_CONCURRENT);
  const maxConcurrent =
    parsedMaxConcurrent !== undefined
      ? Math.max(1, Math.floor(parsedMaxConcurrent))
      : DEFAULT_MAX_CONCURRENT;

  return { minIntervalMs, maxConcurrent };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Enforces both a start-to-start spacing and a concurrency cap across calls to run(). */
export class Throttle {
  private readonly minIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastStart: number | undefined;
  private active = 0;
  private readonly waitQueue: Array<() => void> = [];
  private schedulingChain: Promise<void> = Promise.resolve();

  constructor(
    options: ThrottleOptions,
    clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.minIntervalMs = options.minIntervalMs;
    this.maxConcurrent = Math.max(1, options.maxConcurrent);
    this.now = clock.now ?? Date.now;
    this.sleep = clock.sleep ?? defaultSleep;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      await this.awaitSpacingTurn();
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  /** Wait through the throttle's own injectable sleep, outside of a run() slot. */
  async delay(ms: number): Promise<void> {
    await this.sleep(ms);
  }

  private acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.active--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /** Serializes the spacing check + lastStart update so concurrent slots can't race it. */
  private awaitSpacingTurn(): Promise<void> {
    const turn = this.schedulingChain.then(async () => {
      if (this.lastStart !== undefined) {
        const remaining = this.minIntervalMs - (this.now() - this.lastStart);
        if (remaining > 0) await this.sleep(remaining);
      }
      this.lastStart = this.now();
    });
    this.schedulingChain = turn.catch(() => {});
    return turn;
  }
}

let defaultThrottle: Throttle | undefined;

function getDefaultThrottle(): Throttle {
  if (!defaultThrottle) {
    defaultThrottle = new Throttle(resolveThrottleOptions(process.env));
  }
  return defaultThrottle;
}

/** Numeric Retry-After only (seconds); HTTP-date and non-numeric values are rejected. */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

async function requestOnce(
  config: VercelConfig,
  url: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as Error | undefined)?.name === "TimeoutError") {
      throw new ApiError(0, "timeout", "Vercel API request timed out after 30 seconds.");
    }
    // Deliberately generic: raw network errors can embed request details.
    throw new ApiError(0, "network_error", "Network error reaching the Vercel API.");
  }
}

/** Perform an authenticated GET against the Vercel API. */
export async function vercelGet<T>(
  config: VercelConfig,
  path: string,
  params: Record<string, string | number | undefined> = {},
  fetchImpl: typeof fetch = fetch,
  throttle: Throttle = getDefaultThrottle(),
): Promise<T> {
  const url = buildUrl(path, params, config.teamId);
  let res = await throttle.run(() => requestOnce(config, url, fetchImpl));

  if (res.status === 429) {
    const retryAfter = parseRetryAfterSeconds(res.headers.get("retry-after"));
    if (retryAfter !== undefined && retryAfter <= MAX_AUTO_RETRY_AFTER_SECONDS) {
      await throttle.delay(retryAfter * 1000);
      res = await throttle.run(() => requestOnce(config, url, fetchImpl));
    }
  }

  if (!res.ok) {
    let code: string | undefined;
    let message = `Vercel API responded with HTTP ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* non-JSON body, keep the generic message */
    }
    const safe = redactValues(message, [config.token, config.teamId]).slice(0, MAX_ERROR_LEN);
    throw new ApiError(res.status, code, safe);
  }

  return (await res.json()) as T;
}

function shapeError(): ApiError {
  return new ApiError(
    0,
    "unexpected_response_shape",
    "Vercel API returned an unexpected response shape.",
  );
}

/** Guard a collection field that, if present in an otherwise-parsed 2xx body, must be an array. */
export function assertArrayField(data: Record<string, unknown>, field: string): void {
  if (typeof data !== "object" || data === null) throw shapeError();
  if (field in data && !Array.isArray(data[field])) {
    throw shapeError();
  }
}

/** Guard a single-project body before it is cast and mapped. */
export function assertProjectShape(
  data: unknown,
): asserts data is { id: string; name: string } & Record<string, unknown> {
  if (typeof data !== "object" || data === null) throw shapeError();
  const obj = data as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.name !== "string") throw shapeError();
}

/** Guard a single-deployment body; provider identity may be absent in a partial 2xx result. */
export function assertDeploymentShape<T>(data: T): asserts data is T & Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw shapeError();
  const obj = data as Record<string, unknown>;
  if (obj.uid !== undefined && typeof obj.uid !== "string") throw shapeError();
  if (obj.id !== undefined && typeof obj.id !== "string") throw shapeError();
}

/** Shape any error into a clean, client-safe string. */
export function formatToolError(err: unknown, config?: VercelConfig): string {
  let msg: string;
  if (err instanceof ConfigError) {
    msg = `Configuration problem: ${err.message}`;
  } else if (err instanceof ApiError) {
    const hint =
      err.status === 401 || err.status === 403
        ? " Check that the configured credential is valid and has access to this project or team."
        : err.status === 429
          ? " Rate limited by the Vercel API, so retry after a short wait."
          : "";
    const body = hint && err.message && !/[.!?]$/.test(err.message) ? `${err.message}.` : err.message;
    msg = `Vercel API error (HTTP ${err.status}${err.code ? `, ${err.code}` : ""}): ${body}${hint}`;
  } else if (err instanceof Error) {
    msg = `Unexpected error: ${err.message}`;
  } else {
    msg = "Unexpected error.";
  }
  return redactValues(msg, [config?.token, config?.teamId]).slice(0, MAX_ERROR_LEN + 100);
}

/**
 * The fixed prefix on every transport diagnostic. Stable text, because a host
 * that greps stderr greps for this.
 */
export const TRANSPORT_ERROR_PREFIX = "vercel-deployment-mcp transport error: ";

/**
 * One line of stderr for an out-of-band transport error.
 *
 * The transport hands this callback anything: an Error, an Error subclass with
 * vendor prose, or (through `toError`) a String() of a non-Error throw. The
 * message can carry client-supplied text, so it is redacted against the
 * configured credentials read from the environment at call time, collapsed to a
 * single line, and cut to MAX_ERROR_LEN. Redaction runs on the raw text, before
 * the collapse, because a configured value may itself contain whitespace and
 * would no longer match its own bytes once the collapse had rewritten them.
 * Never throws, for any input: a diagnostic path that can throw is worse than
 * no diagnostic path.
 *
 * The environment is read directly rather than through getConfig(), because
 * getConfig() throws a ConfigError when VERCEL_TOKEN is unset and a reporter
 * must still report on a server that was started with no configuration.
 */
export function formatTransportError(
  err: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let raw: string;
  try {
    raw = err instanceof Error ? err.message : String(err);
  } catch {
    raw = "";
  }
  if (typeof raw !== "string") raw = "";
  const safe = redactValues(raw, [env.VERCEL_TOKEN?.trim(), env.VERCEL_TEAM_ID?.trim()]);
  const oneLine = safe.replace(/\s+/g, " ").trim();
  return TRANSPORT_ERROR_PREFIX + (oneLine.slice(0, MAX_ERROR_LEN) || "unknown transport error");
}
