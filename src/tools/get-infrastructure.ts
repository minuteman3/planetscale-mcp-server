import { Gram } from "@gram-ai/functions";
import { z } from "zod";
import { PlanetScaleAPIError, apiRequest, API_BASE_INTERNAL } from "../lib/planetscale-api.ts";
import { getAuthToken, getAuthHeader } from "../lib/auth.ts";

interface VtTablet {
  type: "BranchInfrastructureVtTablet";
  tablet_type: "primary" | "replica";
  name: string;
  availability_zone: string;
  keyspace: string;
  shard: string;
  metal: boolean;
  cluster_name: string;
  cluster_display_name: string;
}

interface KeyspaceShard {
  type: "BranchInfrastructureKeyspaceShard";
  shard: string;
  state: string;
  last_rollout_started_at: string | null;
  last_rollout_finished_at: string | null;
}

interface InfrastructureKeyspace {
  type: "BranchInfrastructureKeyspace";
  state: string;
  ready: boolean;
  name: string;
  metal: boolean;
  shards: KeyspaceShard[];
}

interface InfrastructureResponse {
  type: "BranchInfrastructure";
  keyspace: string;
  shard: string;
  shards: string[];
  state: string;
  vtgate_display_name: string;
  vtgate_name: string;
  vtgates_tally: Record<string, number>;
  vttablets: VtTablet[];
  branch_infrastructure_keyspace: InfrastructureKeyspace;
  resizing: boolean;
  keyspaces: { name: string; resizing: boolean; ready: boolean; metal: boolean }[];
}

async function fetchInfrastructure(
  organization: string,
  database: string,
  branch: string,
  authHeader: string,
  keyspace?: string,
  shard?: string,
): Promise<InfrastructureResponse> {
  const params = new URLSearchParams();
  if (keyspace) params.set("keyspace", keyspace);
  if (shard) params.set("shard", shard);
  const qs = params.toString();

  const endpoint = `/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(database)}/branches/${encodeURIComponent(branch)}/infrastructure${qs ? `?${qs}` : ""}`;

  return apiRequest<InfrastructureResponse>(endpoint, authHeader, { apiBase: API_BASE_INTERNAL });
}

export const getInfrastructureGram = new Gram().tool({
  name: "get_infrastructure",
  description:
    "Vitess/MySQL databases only. Get the actual deployed infrastructure for a PlanetScale database branch. This is the authoritative source for shard sizing — use this tool (not get_branch_keyspaces) when asking 'what size are my shards?'. Returns real VTGate sizes, per-shard cluster sizes (hardware SKUs), tablet placement across availability zones, and keyspace state. When called without a shard parameter, returns infrastructure for the default shard only — to get a specific shard's hardware, pass the shard parameter. To get ALL shard sizes, set all_shards=true (makes one API call per shard).",
  inputSchema: {
    organization: z.string().describe("PlanetScale organization name"),
    database: z.string().describe("Database name"),
    branch: z.string().describe("Branch name (e.g., 'main')"),
    keyspace: z
      .string()
      .optional()
      .describe("Keyspace name to inspect. If omitted, uses the branch default."),
    shard: z
      .string()
      .optional()
      .describe("Shard key range to inspect (e.g., '10-12', '-02', 'fe-'). If omitted, returns the default shard."),
    all_shards: z
      .boolean()
      .optional()
      .describe("Fetch infrastructure for ALL shards and return a per-shard size summary. Makes one API call per shard."),
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

      const { organization, database, branch } = input;
      if (!organization || !database || !branch) {
        return ctx.text("Error: organization, database, and branch are required.");
      }

      const authHeader = getAuthHeader(env);

      // Single shard or default view
      if (!input.all_shards) {
        const data = await fetchInfrastructure(
          organization,
          database,
          branch,
          authHeader,
          input.keyspace,
          input.shard,
        );

        const primaryTablet = data.vttablets.find((t) => t.tablet_type === "primary");
        const replicaTablets = data.vttablets.filter((t) => t.tablet_type === "replica");

        return ctx.json({
          organization,
          database,
          branch,
          keyspace: data.keyspace,
          shard: data.shard,
          state: data.state,
          resizing: data.resizing,
          vtgate: {
            display_name: data.vtgate_display_name,
            name: data.vtgate_name,
            tally_by_az: data.vtgates_tally,
          },
          primary: primaryTablet
            ? {
                cluster_size: primaryTablet.cluster_display_name,
                cluster_sku: primaryTablet.cluster_name,
                metal: primaryTablet.metal,
                availability_zone: primaryTablet.availability_zone,
              }
            : null,
          replicas: replicaTablets.map((t) => ({
            cluster_size: t.cluster_display_name,
            cluster_sku: t.cluster_name,
            metal: t.metal,
            availability_zone: t.availability_zone,
          })),
          keyspaces: data.keyspaces,
          all_shards: data.shards,
          shard_count: data.shards.length,
        });
      }

      // All-shards mode: discover shards, then fan out
      const initial = await fetchInfrastructure(
        organization,
        database,
        branch,
        authHeader,
        input.keyspace,
      );

      const shards = initial.shards;
      if (shards.length === 0) {
        return ctx.text("No shards found for this keyspace.");
      }

      const results = await Promise.allSettled(
        shards.map((shard) =>
          fetchInfrastructure(organization, database, branch, authHeader, input.keyspace ?? initial.keyspace, shard)
            .then((data) => {
              const primary = data.vttablets.find((t) => t.tablet_type === "primary");
              return {
                shard,
                cluster_size: primary?.cluster_display_name ?? "unknown",
                cluster_sku: primary?.cluster_name ?? "unknown",
                metal: primary?.metal ?? false,
              };
            }),
        ),
      );

      const shardSizes: { shard: string; cluster_size: string; cluster_sku: string; metal: boolean }[] = [];
      const errors: string[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          shardSizes.push(r.value);
        } else {
          errors.push(
            r.reason instanceof PlanetScaleAPIError
              ? `${r.reason.message} (status: ${r.reason.statusCode})`
              : String(r.reason),
          );
        }
      }

      // Build size distribution summary
      const sizeCounts: Record<string, number> = {};
      for (const s of shardSizes) {
        sizeCounts[s.cluster_size] = (sizeCounts[s.cluster_size] ?? 0) + 1;
      }

      const mostCommonSize = Object.entries(sizeCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
      const nonDefaultShards = shardSizes.filter((s) => s.cluster_size !== mostCommonSize);

      const result: Record<string, unknown> = {
        organization,
        database,
        branch,
        keyspace: initial.keyspace,
        vtgate: {
          display_name: initial.vtgate_display_name,
          name: initial.vtgate_name,
          tally_by_az: initial.vtgates_tally,
        },
        shard_count: shards.length,
        size_distribution: sizeCounts,
        default_size: mostCommonSize,
        non_default_shards: nonDefaultShards.map((s) => ({
          shard: s.shard,
          cluster_size: s.cluster_size,
        })),
      };

      if (errors.length > 0) {
        result["errors"] = errors;
      }

      return ctx.json(result);
    } catch (error) {
      if (error instanceof PlanetScaleAPIError) {
        if (error.statusCode === 404) {
          return ctx.text(
            `Error: Not found. Check that the organization, database, branch, and keyspace/shard names are correct. (status: 404)`,
          );
        }
        return ctx.text(`Error: ${error.message} (status: ${error.statusCode})`);
      }
      if (error instanceof Error) {
        return ctx.text(`Error: ${error.message}`);
      }
      return ctx.text("Error: An unexpected error occurred");
    }
  },
});
