import { Gram } from "@gram-ai/functions";
import { z } from "zod";
import { PlanetScaleAPIError } from "../lib/planetscale-api.ts";
import { getAuthToken, getAuthHeader } from "../lib/auth.ts";

const API_BASE = "https://api.planetscale.com/v1";

interface Actor {
  id: string;
  type: string;
  display_name: string;
  avatar_url: string;
}

interface DeployOperation {
  id: string;
  type: string;
  state: string;
  keyspace_name: string;
  table_name: string;
  operation_name: string;
  ddl_statement: string;
  eta_seconds: number | null;
  progress_percentage: number | null;
  can_drop_data: boolean;
  created_at: string;
  updated_at: string;
}

interface Deployment {
  id: string;
  type: string;
  state: string;
  into_branch: string;
  deploy_request_number: number;
  auto_cutover: boolean;
  deploy_operations: DeployOperation[];
  created_at: string;
  finished_at: string | null;
  cutover_at: string | null;
}

interface DeployRequest {
  id: string;
  type: string;
  number: number;
  state: string;
  deployment_state: string;
  branch: string;
  branch_id: string;
  into_branch: string;
  approved: boolean;
  actor: Actor;
  closed_by: Actor | null;
  deployment: Deployment;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deployed_at: string | null;
  html_url: string;
}

interface PaginatedList<T> {
  type: "list";
  current_page: number;
  next_page: number | null;
  data: T[];
}

function summarizeDeployRequest(entry: DeployRequest) {
  // Deduplicate per-shard operations: the API returns one operation per shard
  // for sharded keyspaces with identical DDL but potentially different progress.
  // Group by (keyspace, table, operation, ddl) and aggregate the varying fields
  // (state, progress, eta) across shards.
  const grouped = new Map<string, DeployOperation[]>();
  for (const op of entry.deployment.deploy_operations) {
    const key = `${op.keyspace_name}|${op.table_name}|${op.operation_name}|${op.ddl_statement}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(op);
    } else {
      grouped.set(key, [op]);
    }
  }

  const ops = Array.from(grouped.values()).map((shardOps) => {
    const first = shardOps[0]!;
    const summary: Record<string, unknown> = {
      keyspace: first.keyspace_name,
      table: first.table_name,
      operation: first.operation_name,
      ddl: first.ddl_statement,
    };

    if (shardOps.length > 1) {
      summary["shard_count"] = shardOps.length;

      // Aggregate state across shards
      const stateCounts: Record<string, number> = {};
      for (const op of shardOps) {
        stateCounts[op.state] = (stateCounts[op.state] ?? 0) + 1;
      }
      const uniqueStates = Object.keys(stateCounts);
      summary["state"] = uniqueStates.length === 1
        ? uniqueStates[0]
        : stateCounts;

      // Aggregate progress across shards
      const progresses = shardOps.map((op) => op.progress_percentage).filter((p): p is number => p != null);
      if (progresses.length > 0) {
        const min = Math.min(...progresses);
        const max = Math.max(...progresses);
        summary["progress_pct"] = min === max ? min : { min, max };
      }

      // Aggregate ETA across shards
      const etas = shardOps.map((op) => op.eta_seconds).filter((e): e is number => e != null && e > 0);
      if (etas.length > 0) {
        summary["max_eta_seconds"] = Math.max(...etas);
      }
    } else {
      summary["state"] = first.state;
      if (first.progress_percentage != null) {
        summary["progress_pct"] = first.progress_percentage;
      }
      if (first.eta_seconds != null && first.eta_seconds > 0) {
        summary["eta_seconds"] = first.eta_seconds;
      }
    }

    if (first.can_drop_data) {
      summary["can_drop_data"] = true;
    }
    return summary;
  });

  return {
    number: entry.number,
    state: entry.state,
    deployment_state: entry.deployment_state,
    branch: entry.branch,
    into_branch: entry.into_branch,
    actor: entry.actor.display_name,
    auto_cutover: entry.deployment.auto_cutover,
    created_at: entry.created_at,
    deployed_at: entry.deployed_at,
    closed_at: entry.closed_at,
    operations: ops,
  };
}

/**
 * Build a PlanetScale range filter string: "start..end"
 */
function buildRangeFilter(from: string, to: string): string {
  return `${from}..${to}`;
}

async function fetchDeployRequests(
  organization: string,
  database: string,
  authHeader: string,
  options: {
    intoBranch?: string;
    state?: string;
    deployedAtFrom?: string;
    deployedAtTo?: string;
    page: number;
    perPage: number;
  },
): Promise<PaginatedList<DeployRequest>> {
  const params = new URLSearchParams();
  params.set("page", String(options.page));
  params.set("per_page", String(options.perPage));
  if (options.intoBranch) {
    params.set("into_branch", options.intoBranch);
  }
  if (options.state) {
    params.set("state", options.state);
  }
  if (options.deployedAtFrom && options.deployedAtTo) {
    params.set("deployed_at", buildRangeFilter(options.deployedAtFrom, options.deployedAtTo));
  }

  const url = `${API_BASE}/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(database)}/deploy-requests?${params}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    let details: unknown;
    try {
      details = await response.json();
    } catch {
      details = await response.text();
    }
    throw new PlanetScaleAPIError(
      `Failed to fetch deploy requests: ${response.statusText}`,
      response.status,
      details,
    );
  }

  return (await response.json()) as PaginatedList<DeployRequest>;
}

interface Workflow {
  id: string;
  name: string;
  number: number;
  state: string;
  workflow_type: string;
  workflow_subtype: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  reversed_at: string | null;
  data_copy_completed_at: string | null;
  verify_data_at: string | null;
  switch_replicas_at: string | null;
  switch_primaries_at: string | null;
  cutover_at: string | null;
  replicas_switched: boolean;
  primaries_switched: boolean;
  workflow_errors: string | null;
  source_keyspace: { name: string } | null;
  target_keyspace: { name: string } | null;
  actor: Actor | null;
  created_at: string;
  updated_at: string;
}

function summarizeWorkflow(entry: Workflow) {
  return {
    number: entry.number,
    name: entry.name,
    state: entry.state,
    workflow_type: entry.workflow_type,
    source_keyspace: entry.source_keyspace?.name ?? null,
    target_keyspace: entry.target_keyspace?.name ?? null,
    actor: entry.actor?.display_name ?? null,
    created_at: entry.created_at,
    started_at: entry.started_at,
    data_copy_completed_at: entry.data_copy_completed_at,
    verify_data_at: entry.verify_data_at,
    switch_replicas_at: entry.switch_replicas_at,
    switch_primaries_at: entry.switch_primaries_at,
    cutover_at: entry.cutover_at,
    completed_at: entry.completed_at,
    ...(entry.workflow_errors ? { errors: entry.workflow_errors } : {}),
  };
}

async function fetchWorkflows(
  organization: string,
  database: string,
  authHeader: string,
  options: {
    from?: string;
    to?: string;
    page: number;
    perPage: number;
  },
): Promise<PaginatedList<Workflow>> {
  const params = new URLSearchParams();
  params.set("page", String(options.page));
  params.set("per_page", String(options.perPage));
  if (options.from && options.to) {
    params.set("between", buildRangeFilter(options.from, options.to));
  }

  const url = `${API_BASE}/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(database)}/workflows?${params}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: authHeader, Accept: "application/json" },
  });

  if (!response.ok) {
    let details: unknown;
    try { details = await response.json(); } catch { details = await response.text(); }
    throw new PlanetScaleAPIError(`Failed to fetch workflows: ${response.statusText}`, response.status, details);
  }

  return (await response.json()) as PaginatedList<Workflow>;
}

export const listDeployRequestsGram = new Gram().tool({
  name: "list_deploy_requests",
  description:
    "Vitess/MySQL databases only. List deploy requests (schema migrations) and VReplication workflows for a PlanetScale database. Deploy requests show DDL operations (ALTER TABLE, CREATE INDEX, etc.) and their progress. Workflows show MoveTables/Reshard operations with milestone timestamps (data copy, verify, switch replicas, switch primaries, cutover, complete).",
  inputSchema: {
    organization: z.string().describe("PlanetScale organization name"),
    database: z.string().describe("Database name"),
    into_branch: z
      .string()
      .optional()
      .describe("Filter by target branch (e.g., 'main')"),
    state: z
      .enum(["open", "closed"])
      .optional()
      .describe("Filter by deploy request state: 'open' or 'closed'"),
    from: z
      .string()
      .optional()
      .describe(
        "Start of time range (ISO 8601, e.g., '2026-03-25T00:00:00.000Z'). Filters deploy requests by deployed_at and workflows by active time range. Must be paired with 'to'.",
      ),
    to: z
      .string()
      .optional()
      .describe(
        "End of time range (ISO 8601, e.g., '2026-03-25T23:59:00.000Z'). Must be paired with 'from'.",
      ),
    include_workflows: z
      .boolean()
      .optional()
      .describe(
        "Include VReplication workflows (MoveTables, Reshard) with milestone timestamps (default: false).",
      ),
    page: z.number().optional().describe("Page number (default: 1)"),
    per_page: z
      .number()
      .optional()
      .describe("Results per page (default: 10, max: 25)"),
  },
  async execute(ctx, input) {
    try {
      const env =
        Object.keys(ctx.env).length > 0
          ? (ctx.env as Record<string, string | undefined>)
          : process.env;

      const auth = getAuthToken(env);
      if (!auth) {
        return ctx.text("Error: No PlanetScale authentication configured.");
      }

      const { organization, database } = input;
      if (!organization || !database) {
        return ctx.text("Error: organization and database are required.");
      }

      const page = input.page ?? 1;
      const perPage = Math.min(input.per_page ?? 10, 25);
      const authHeader = getAuthHeader(env);
      const includeWorkflows = input.include_workflows ?? false;

      const [deployResult, workflowResult] = await Promise.allSettled([
        fetchDeployRequests(organization, database, authHeader, {
          intoBranch: input.into_branch,
          state: input.state,
          deployedAtFrom: input.from,
          deployedAtTo: input.to,
          page,
          perPage,
        }),
        includeWorkflows
          ? fetchWorkflows(organization, database, authHeader, {
              from: input.from,
              to: input.to,
              page,
              perPage,
            })
          : Promise.resolve(null),
      ]);

      const result: Record<string, unknown> = { organization, database };

      if (deployResult.status === "fulfilled") {
        const list = deployResult.value;
        result["deploy_requests"] = {
          total: list.data.length,
          page: list.current_page,
          next_page: list.next_page,
          requests: list.data.map(summarizeDeployRequest),
        };
      } else {
        result["deploy_requests"] = {
          error: deployResult.reason instanceof PlanetScaleAPIError
            ? `${deployResult.reason.message} (status: ${deployResult.reason.statusCode})`
            : "Failed to fetch deploy requests",
        };
      }

      if (includeWorkflows) {
        if (workflowResult.status === "fulfilled" && workflowResult.value) {
          const list = workflowResult.value;
          result["workflows"] = {
            total: list.data.length,
            page: list.current_page,
            next_page: list.next_page,
            workflows: list.data.map(summarizeWorkflow),
          };
        } else if (workflowResult.status === "rejected") {
          result["workflows"] = {
            error: workflowResult.reason instanceof PlanetScaleAPIError
              ? `${workflowResult.reason.message} (status: ${workflowResult.reason.statusCode})`
              : "Failed to fetch workflows",
          };
        }
      }

      return ctx.json(result);
    } catch (error) {
      if (error instanceof PlanetScaleAPIError) {
        return ctx.text(`Error: ${error.message} (status: ${error.statusCode})`);
      }
      if (error instanceof Error) {
        return ctx.text(`Error: ${error.message}`);
      }
      return ctx.text("Error: An unexpected error occurred");
    }
  },
});
