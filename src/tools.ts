import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatToolError, getConfig, vercelGet } from "./vercel.js";

/** Bounded, readable JSON for tool responses. */
function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function asError(err: unknown) {
  let cfg;
  try {
    cfg = getConfig();
  } catch {
    /* config itself may be the problem; formatToolError handles both */
  }
  return {
    content: [{ type: "text" as const, text: formatToolError(err, cfg) }],
    isError: true,
  };
}

interface Project {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number;
}

interface Deployment {
  uid?: string;
  id?: string;
  name?: string;
  url?: string;
  state?: string;
  readyState?: string;
  createdAt?: number;
  target?: string | null;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "list_projects",
    {
      title: "List Vercel projects",
      description:
        "List projects visible to the configured account or team. Optional text search and result limit.",
      inputSchema: {
        search: z.string().optional().describe("Filter projects by name"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      },
    },
    async ({ search, limit }) => {
      try {
        const config = getConfig();
        const data = await vercelGet<{ projects: Project[] }>(config, "/v9/projects", {
          search,
          limit: limit ?? 20,
        });
        const projects = (data.projects ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          framework: p.framework ?? null,
          updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : undefined,
        }));
        return asText({ count: projects.length, projects });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Get a Vercel project",
      description: "Fetch one project by ID or name.",
      inputSchema: {
        idOrName: z.string().min(1).describe("Project ID or project name"),
      },
    },
    async ({ idOrName }) => {
      try {
        const config = getConfig();
        const p = await vercelGet<Project & Record<string, unknown>>(
          config,
          `/v9/projects/${encodeURIComponent(idOrName)}`,
        );
        return asText({
          id: p.id,
          name: p.name,
          framework: p.framework ?? null,
          updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : undefined,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "list_deployments",
    {
      title: "List deployments",
      description:
        "List recent deployments, optionally filtered by project ID and state (e.g. BUILDING, ERROR, READY).",
      inputSchema: {
        projectId: z.string().optional().describe("Limit to one project"),
        state: z.string().optional().describe("Comma-separated states, e.g. READY,ERROR"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      },
    },
    async ({ projectId, state, limit }) => {
      try {
        const config = getConfig();
        const data = await vercelGet<{ deployments: Deployment[] }>(config, "/v6/deployments", {
          projectId,
          state,
          limit: limit ?? 20,
        });
        const deployments = (data.deployments ?? []).map((d) => ({
          id: d.uid ?? d.id,
          name: d.name,
          url: d.url,
          state: d.state ?? d.readyState,
          target: d.target ?? null,
          createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
        }));
        return asText({ count: deployments.length, deployments });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "get_deployment",
    {
      title: "Get a deployment",
      description: "Fetch one deployment by ID or URL, including its current state.",
      inputSchema: {
        idOrUrl: z.string().min(1).describe("Deployment ID (dpl_…) or deployment URL"),
      },
    },
    async ({ idOrUrl }) => {
      try {
        const config = getConfig();
        const d = await vercelGet<Deployment & Record<string, unknown>>(
          config,
          `/v13/deployments/${encodeURIComponent(idOrUrl)}`,
        );
        return asText({
          id: d.uid ?? d.id,
          name: d.name,
          url: d.url,
          state: d.state ?? d.readyState,
          target: d.target ?? null,
          createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );
}
