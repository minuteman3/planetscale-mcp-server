import { Gram } from "@gram-ai/functions";
import { z } from "zod";
import {
  getDatabase,
  createVitessCredentials,
  createPostgresCredentials,
  PlanetScaleAPIError,
} from "../lib/planetscale-api.ts";
import {
  executeVitessQuery,
  executePostgresQuery,
} from "../lib/query-executor.ts";
import { validateReadQuery } from "../lib/query-validator.ts";
import { getAuthToken, getAuthHeader } from "../lib/auth.ts";

export const executeReadQueryGram = new Gram().tool({
  name: "execute_read_query",
  description:
    "Execute a read-only SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN) against a PlanetScale database. This tool creates short-lived credentials and executes the query securely.",
  inputSchema: {
    organization: z.string().describe("PlanetScale organization name"),
    database: z.string().describe("Database name"),
    branch: z.string().describe("Branch name (e.g., 'main')"),
    query: z.string().describe("SQL SELECT query to execute"),
  },
  async execute(ctx, input) {
    console.error(`[execute_read_query] Called with input:`, JSON.stringify(input));
    
    try {
      // Try ctx.env first, fall back to process.env for local development
      const env = Object.keys(ctx.env).length > 0
        ? (ctx.env as Record<string, string | undefined>)
        : process.env;

      // Debug: log environment info
      const envSource = Object.keys(ctx.env).length > 0 ? 'ctx.env' : 'process.env';
      const hasOAuth = !!env["PLANETSCALE_OAUTH2_ACCESS_TOKEN"];
      const hasApiToken = !!env["PLANETSCALE_API_TOKEN"];
      console.error(`[execute_read_query] Using env source: ${envSource}`);
      console.error(`[execute_read_query] Has OAuth token: ${hasOAuth}, Has API token: ${hasApiToken}`);

      // Check authentication
      const auth = getAuthToken(env);
      if (!auth) {
        const debugInfo = `envSource: ${envSource}, hasOAuth: ${hasOAuth}, hasApiToken: ${hasApiToken}`;
        return ctx.text(`Error: No PlanetScale authentication configured. Set PLANETSCALE_OAUTH2_ACCESS_TOKEN or PLANETSCALE_API_TOKEN. Debug: ${debugInfo}`);
      }
      console.error(`[execute_read_query] Using auth type: ${auth.authType}`);

      const query = input["query"];
      if (!query) {
        return ctx.text("Error: query is required");
      }

      const organization = input["organization"];
      const database = input["database"];
      const branch = input["branch"];

      if (!organization || !database || !branch) {
        return ctx.text("Error: organization, database, and branch are required");
      }

      // Validate the query is read-only
      const validation = validateReadQuery(query);
      if (!validation.allowed) {
        return ctx.text(`Error: ${validation.reason ?? "Query validation failed"}`);
      }

      // Get auth header for API calls
      const authHeader = getAuthHeader(env);

      // Get database info to determine type
      console.error(`[execute_read_query] Fetching database info for ${organization}/${database}`);
      const db = await getDatabase(organization, database, authHeader);
      console.error(`[execute_read_query] Database kind: ${db.kind}`);

      if (db.kind === "mysql") {
        // Vitess database - create password with reader role
        console.error(`[execute_read_query] Creating Vitess credentials for branch ${branch}`);
        const credentials = await createVitessCredentials(
          organization,
          database,
          branch,
          "reader",
          authHeader
        );
        console.error(`[execute_read_query] Credentials created, executing query`);

        const result = await executeVitessQuery(credentials, query);
        return ctx.json(result);
      } else {
        // Postgres database - create role with read permissions
        console.error(`[execute_read_query] Creating Postgres credentials for branch ${branch}`);
        const credentials = await createPostgresCredentials(
          organization,
          database,
          branch,
          ["pg_read_all_data"],
          authHeader
        );
        console.error(`[execute_read_query] Credentials created, executing query`);

        const result = await executePostgresQuery(credentials, query);
        return ctx.json(result);
      }
    } catch (error) {
      console.error(`[execute_read_query] Error:`, error);
      
      if (error instanceof PlanetScaleAPIError) {
        return ctx.text(`Error: ${error.message} (status: ${error.statusCode})`);
      }

      if (error instanceof Error) {
        return ctx.text(`Error: ${error.message}`);
      }

      return ctx.text(`Error: An unexpected error occurred`);
    }
  },
});
