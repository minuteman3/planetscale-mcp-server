import { Gram } from "@gram-ai/functions";
import { z } from "zod";
import { PlanetScaleAPIError } from "../lib/planetscale-api.ts";
import { getAuthToken, getAuthHeader } from "../lib/auth.ts";

// The metrics API uses /internal/ not /v1/
const API_BASE = "https://api.planetscale.com/internal";

/**
 * A data point is a tuple of [unix_timestamp, value]
 */
export type MetricDataPoint = [number, number];

/**
 * A single metric series returned by the API.
 * `label` is human-readable (e.g. "Reads") for branch metrics,
 * or the query_id string for per-query metrics.
 */
export interface MetricSeries {
  metric: string;
  label: string;
  labels: Record<string, string>;
  points: MetricDataPoint[];
}

/**
 * Top-level metrics API response (same shape for both endpoints)
 */
export interface MetricsResponse {
  type: string;
  start_date: string;
  end_date: string;
  interval: number;
  series: MetricSeries[];
}

/**
 * Fetch branch-level aggregate metrics
 */
async function fetchBranchMetrics(
  organization: string,
  database: string,
  branch: string,
  metrics: string[],
  options: {
    period?: string;
    from?: string;
    to?: string;
    steps?: number;
  },
  authHeader: string
): Promise<MetricsResponse> {
  const params = new URLSearchParams();
  for (const m of metrics) {
    params.append("metrics[]", m);
  }
  if (options.period) {
    params.set("period", options.period);
  }
  if (options.from) {
    params.set("from", options.from);
  }
  if (options.to) {
    params.set("to", options.to);
  }
  if (options.steps) {
    params.set("steps", String(options.steps));
  }

  const url = `${API_BASE}/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(database)}/branches/${encodeURIComponent(branch)}/metrics?${params.toString()}`;

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

    if (response.status === 404) {
      throw new PlanetScaleAPIError(
        "Metrics not found. Please check your organization, database, and branch names.",
        response.status,
        details
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new PlanetScaleAPIError(
        "Permission denied. Please check your API token has the required permissions.",
        response.status,
        details
      );
    }

    throw new PlanetScaleAPIError(
      `Failed to fetch branch metrics: ${response.statusText}`,
      response.status,
      details
    );
  }

  return (await response.json()) as MetricsResponse;
}

/**
 * Fetch per-query metrics for specific query fingerprints
 */
async function fetchQueryMetrics(
  organization: string,
  database: string,
  branch: string,
  metrics: string[],
  queryIds: string[],
  options: {
    from?: string;
    to?: string;
    steps?: number;
  },
  authHeader: string
): Promise<MetricsResponse> {
  const params = new URLSearchParams();
  for (const m of metrics) {
    params.append("metrics[]", m);
  }
  for (const qid of queryIds) {
    params.append("query_ids[]", qid);
  }
  if (options.from) {
    params.set("from", options.from);
  }
  if (options.to) {
    params.set("to", options.to);
  }
  if (options.steps) {
    params.set("steps", String(options.steps));
  }

  const url = `${API_BASE}/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(database)}/branches/${encodeURIComponent(branch)}/metrics/query?${params.toString()}`;

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

    if (response.status === 404) {
      throw new PlanetScaleAPIError(
        "Query metrics not found. Please check your organization, database, branch, and query IDs.",
        response.status,
        details
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new PlanetScaleAPIError(
        "Permission denied. Please check your API token has the required permissions.",
        response.status,
        details
      );
    }

    throw new PlanetScaleAPIError(
      `Failed to fetch query metrics: ${response.statusText}`,
      response.status,
      details
    );
  }

  return (await response.json()) as MetricsResponse;
}

export const getMetricsGram = new Gram().tool({
  name: "get_metrics",
  description:
    "Vitess/MySQL databases only. Get time-series metrics for a PlanetScale database branch. Provides two modes: (1) Branch-level aggregate metrics like rows_read, rows_written, latency_p95, queries, query_errors, and index_usage_percent over a time period. (2) Per-query metrics for specific query fingerprints, enabling before/after comparisons for optimization work. Use `get_insights` first to discover query fingerprints and their keyspaces, then use this tool with `query_ids` (format: `{fingerprint}-{keyspace}` matching the `id` field from insights) to get detailed time-series data for those queries. Note: egress_bytes values are raw bytes; the PlanetScale UI displays these as binary megabytes (1 MB = 2^20 bytes). Latencies are in milliseconds. Each data point is a [unix_timestamp, value] tuple.",
  inputSchema: {
    organization: z.string().describe("PlanetScale organization name"),
    database: z.string().describe("Database name"),
    branch: z.string().describe("Branch name (e.g., 'main')"),
    metrics: z
      .array(z.string())
      .describe(
        "Metrics to retrieve. Branch-level: 'rows_read', 'rows_written', 'latency_p95', 'queries', 'query_errors', 'index_usage_percent'. Per-query: 'queries', 'latency_p50', 'latency_p99', 'latency_max', 'total_duration_millis', 'rows_read_per_returned', 'rows_read', 'rows_written', 'egress_bytes', 'egress_bytes_per_query', 'max_egress_bytes'."
      ),
    query_ids: z
      .array(z.string())
      .optional()
      .describe(
        "Query fingerprint IDs for per-query metrics. Format: '{fingerprint}-{keyspace}' (matches the `id` field from get_insights results). When provided, uses the per-query metrics endpoint."
      ),
    period: z
      .string()
      .optional()
      .describe(
        "Time period for branch-level metrics (e.g., '1h', '6h', '1d', '7d', '30d'). Only used in branch-level mode (when query_ids is not provided)."
      ),
    from: z
      .string()
      .optional()
      .describe(
        "Start of time range (ISO 8601 format, e.g., '2026-03-12T18:50:00.000Z'). Used for precise time ranges in both modes."
      ),
    to: z
      .string()
      .optional()
      .describe(
        "End of time range (ISO 8601 format). Used for precise time ranges in both modes."
      ),
    steps: z
      .number()
      .optional()
      .describe(
        "Number of data points to return in the time series. Higher values give finer granularity. Typically 50-100 for dashboard-style views."
      ),
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

      const { organization, database, branch, metrics } = input;

      if (!organization || !database || !branch) {
        return ctx.text(
          "Error: organization, database, and branch are required"
        );
      }

      if (!metrics || metrics.length === 0) {
        return ctx.text("Error: at least one metric is required");
      }

      const authHeader = getAuthHeader(env);
      const queryIds = input["query_ids"];

      if (queryIds && queryIds.length > 0) {
        // Per-query metrics mode
        const result = await fetchQueryMetrics(
          organization,
          database,
          branch,
          metrics,
          queryIds,
          {
            from: input["from"],
            to: input["to"],
            steps: input["steps"],
          },
          authHeader
        );

        return ctx.json({
          mode: "per_query",
          metrics_requested: metrics,
          query_ids: queryIds,
          from: input["from"],
          to: input["to"],
          steps: input["steps"],
          ...result,
        });
      } else {
        // Branch-level metrics mode
        const result = await fetchBranchMetrics(
          organization,
          database,
          branch,
          metrics,
          {
            period: input["period"],
            from: input["from"],
            to: input["to"],
            steps: input["steps"],
          },
          authHeader
        );

        return ctx.json({
          mode: "branch",
          metrics_requested: metrics,
          period: input["period"],
          from: input["from"],
          to: input["to"],
          ...result,
        });
      }
    } catch (error) {
      if (error instanceof PlanetScaleAPIError) {
        return ctx.text(
          `Error: ${error.message} (status: ${error.statusCode})`
        );
      }

      if (error instanceof Error) {
        return ctx.text(`Error: ${error.message}`);
      }

      return ctx.text(`Error: An unexpected error occurred`);
    }
  },
});
