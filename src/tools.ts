import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatToolError, getConfig, vercelGet, type VercelConfig } from "./vercel.js";

const ENDPOINT_PROFILE = "vercel-read-v1";
const ENDPOINTS = {
  listProjects: "/v9/projects",
  getProject: "/v9/projects/",
  listDeployments: "/v6/deployments",
  getDeployment: "/v13/deployments/",
} as const;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} satisfies ToolAnnotations;

const ProjectResultSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  framework: z.string().nullable(),
  updatedAt: z.string().optional(),
});

const DeploymentResultSchema = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
  target: z.string().nullable(),
  createdAt: z.string().optional(),
});

function receiptSchema(appliedFilters: z.ZodType) {
  return z.strictObject({
    scopeKind: z.enum(["personal", "team"]),
    appliedFilters,
    endpointProfile: z.literal(ENDPOINT_PROFILE),
  });
}

const NoFiltersSchema = z.array(z.never()).max(0);
const ItemReceiptSchema = receiptSchema(NoFiltersSchema);
const ProjectListReceiptSchema = receiptSchema(z.array(z.literal("search")).max(1));
const DeploymentListReceiptSchema = receiptSchema(
  z.union([
    NoFiltersSchema,
    z.array(z.literal("projectId")).length(1),
    z.array(z.literal("state")).length(1),
    z.intersection(
      z.tuple([z.literal("projectId"), z.literal("state")]),
      z.array(z.enum(["projectId", "state"])).length(2),
    ),
  ]),
);

function pageOutputSchema(item: z.ZodType, receipt: z.ZodType) {
  return z.strictObject({
    pageCount: z.number().int().nonnegative(),
    items: z.array(item),
    receipt,
  });
}

function itemOutputSchema(item: z.ZodType) {
  return z.strictObject({ item, receipt: ItemReceiptSchema });
}

const ListProjectsOutputSchema = pageOutputSchema(ProjectResultSchema, ProjectListReceiptSchema);
const GetProjectOutputSchema = itemOutputSchema(ProjectResultSchema);
const ListDeploymentsOutputSchema = pageOutputSchema(
  DeploymentResultSchema,
  DeploymentListReceiptSchema,
);
const GetDeploymentOutputSchema = itemOutputSchema(DeploymentResultSchema);

/** Return one JSON-safe value in both MCP result representations. */
function asStructured(data: Record<string, unknown>) {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

function receipt(config: VercelConfig, appliedFilters: string[]) {
  return {
    scopeKind: config.teamId ? ("team" as const) : ("personal" as const),
    appliedFilters,
    endpointProfile: ENDPOINT_PROFILE,
  };
}

function isApplied(value: string | undefined): boolean {
  return value !== undefined && value !== "";
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
      outputSchema: ListProjectsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ search, limit }) => {
      try {
        const config = getConfig();
        const data = await vercelGet<{ projects: Project[] }>(config, ENDPOINTS.listProjects, {
          search,
          limit: limit ?? 20,
        });
        const projects = (data.projects ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          framework: p.framework ?? null,
          updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : undefined,
        }));
        return asStructured({
          pageCount: projects.length,
          items: projects,
          receipt: receipt(config, isApplied(search) ? ["search"] : []),
        });
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
      outputSchema: GetProjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ idOrName }) => {
      try {
        const config = getConfig();
        const p = await vercelGet<Project & Record<string, unknown>>(
          config,
          `${ENDPOINTS.getProject}${encodeURIComponent(idOrName)}`,
        );
        return asStructured({
          item: {
            id: p.id,
            name: p.name,
            framework: p.framework ?? null,
            updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : undefined,
          },
          receipt: receipt(config, []),
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
      outputSchema: ListDeploymentsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ projectId, state, limit }) => {
      try {
        const config = getConfig();
        const data = await vercelGet<{ deployments: Deployment[] }>(
          config,
          ENDPOINTS.listDeployments,
          {
            projectId,
            state,
            limit: limit ?? 20,
          },
        );
        const deployments = (data.deployments ?? []).map((d) => ({
          id: d.uid ?? d.id,
          name: d.name,
          url: d.url,
          state: d.state ?? d.readyState,
          target: d.target ?? null,
          createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
        }));
        return asStructured({
          pageCount: deployments.length,
          items: deployments,
          receipt: receipt(
            config,
            [isApplied(projectId) ? "projectId" : undefined, isApplied(state) ? "state" : undefined].filter(
              (name): name is string => name !== undefined,
            ),
          ),
        });
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
      outputSchema: GetDeploymentOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ idOrUrl }) => {
      try {
        const config = getConfig();
        const d = await vercelGet<Deployment & Record<string, unknown>>(
          config,
          `${ENDPOINTS.getDeployment}${encodeURIComponent(idOrUrl)}`,
        );
        return asStructured({
          item: {
            id: d.uid ?? d.id,
            name: d.name,
            url: d.url,
            state: d.state ?? d.readyState,
            target: d.target ?? null,
            createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
          },
          receipt: receipt(config, []),
        });
      } catch (err) {
        return asError(err);
      }
    },
  );
}
