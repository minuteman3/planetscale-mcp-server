/**
 * Authentication utilities for PlanetScale API
 * 
 * Supports two authentication methods:
 * 1. OAuth2 (production): Uses PLANETSCALE_OAUTH2_ACCESS_TOKEN with Bearer auth
 * 2. Service Token (development): Uses PLANETSCALE_API_TOKEN directly
 */

export interface AuthResult {
  token: string;
  authType: "oauth2" | "service_token";
}

/**
 * Get the authentication token and format for PlanetScale API requests.
 *
 * Priority:
 * 1. PLANETSCALE_OAUTH2_ACCESS_TOKEN (OAuth2 - uses Bearer prefix)
 * 2. PLANETSCALE_API_TOKEN (Service token - used directly)
 *
 * @param env - Environment object (from ctx.env or process.env)
 * @returns AuthResult with the formatted token and auth type, or null if no token found
 */
export function getAuthToken(env: Record<string, string | undefined> = process.env): AuthResult | null {
  // Check for OAuth2 token first (production)
  const oauth2Token = env["PLANETSCALE_OAUTH2_ACCESS_TOKEN"];
  if (oauth2Token) {
    return {
      token: `Bearer ${oauth2Token}`,
      authType: "oauth2",
    };
  }

  // Fall back to service token (development)
  const serviceToken = env["PLANETSCALE_API_TOKEN"];
  if (serviceToken) {
    return {
      token: serviceToken,
      authType: "service_token",
    };
  }

  return null;
}

/**
 * Get the authorization header value for PlanetScale API requests.
 * Throws an error if no token is configured.
 *
 * @param env - Environment object (from ctx.env or process.env)
 */
export function getAuthHeader(env: Record<string, string | undefined> = process.env): string {
  const auth = getAuthToken(env);
  if (!auth) {
    throw new Error(
      "No PlanetScale authentication configured. " +
      "Set PLANETSCALE_OAUTH2_ACCESS_TOKEN (OAuth2) or PLANETSCALE_API_TOKEN (service token)."
    );
  }
  return auth.token;
}
