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

/** Replace any occurrence of the given values in text with a placeholder. */
export function redactValues(text: string, values: Array<string | undefined>): string {
  let out = text;
  for (const v of values) {
    if (v && v.length > 0) {
      out = out.split(v).join("[redacted]");
    }
  }
  return out;
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

/** Perform an authenticated GET against the Vercel API. */
export async function vercelGet<T>(
  config: VercelConfig,
  path: string,
  params: Record<string, string | number | undefined> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = buildUrl(path, params, config.teamId);
  let res: Response;
  try {
    res = await fetchImpl(url, {
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

  if (!res.ok) {
    let code: string | undefined;
    let message = `Vercel API responded with HTTP ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* non-JSON body — keep the generic message */
    }
    const safe = redactValues(message, [config.token, config.teamId]).slice(0, MAX_ERROR_LEN);
    throw new ApiError(res.status, code, safe);
  }

  return (await res.json()) as T;
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
          ? " Rate limited by the Vercel API — retry after a short wait."
          : "";
    msg = `Vercel API error (HTTP ${err.status}${err.code ? `, ${err.code}` : ""}): ${err.message}${hint}`;
  } else if (err instanceof Error) {
    msg = `Unexpected error: ${err.message}`;
  } else {
    msg = "Unexpected error.";
  }
  return redactValues(msg, [config?.token, config?.teamId]).slice(0, MAX_ERROR_LEN + 100);
}
