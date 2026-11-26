import { z } from "zod";

/** Configure on the backend of the service registered for NyxID introspection. */
export interface AgentVerifierOptions {
  issuer: string;
  introspectionEndpoint: string;
  serviceId: string;
  clientId: string;
  clientSecret: string;
}

const evidence = z.object({
  active: z.literal(true), token_type: z.literal("api_key"), iss: z.string(), aud: z.string(),
  sub: z.string().min(1), jti: z.string().min(1), scope: z.string(), exp: z.number().int().optional(),
});

/** Returns null for a denied identity. Transport failures reject the promise. */
export function createAgentKeyVerifier({ issuer, introspectionEndpoint, serviceId, clientId, clientSecret }: AgentVerifierOptions) {
  const endpoint = new URL(introspectionEndpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !issuer || !serviceId || !clientId || !clientSecret) {
    throw new Error("Expected a trusted NyxID HTTPS introspection endpoint and resource client configuration");
  }
  return async (credential: string, signal?: AbortSignal) => {
    if (!credential) return null;
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal,
      body: new URLSearchParams({ token: credential, client_id: clientId, client_secret: clientSecret, service_id: serviceId }),
    });
    if (!response.ok) throw new Error("NyxID introspection failed (HTTP " + response.status + ")");
    const result = evidence.safeParse(await response.json());
    if (!result.success) return null;
    const claims = result.data;
    const scopes = claims.scope.split(/\s+/).filter(Boolean);
    if (claims.iss !== issuer || claims.aud !== serviceId || !scopes.includes("proxy") ||
        (claims.exp !== undefined && claims.exp <= Date.now() / 1000)) return null;
    return { issuer, serviceId, keyId: claims.jti, ownerId: claims.sub, scopes };
  };
}
