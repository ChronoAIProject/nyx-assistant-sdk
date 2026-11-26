import { z } from "zod";

const id = z.string().min(1);
const service = z.object({
  id,
  slug: id,
  catalog_service_slug: id.nullish(),
  label: z.string().optional(),
  is_active: z.boolean(),
  status: z.string().optional(),
  credential_missing: z.boolean().optional(),
});

export const serviceListResponse = z.object({ keys: z.array(service) });

export function serviceConnection(row: z.infer<typeof service>) {
  return {
    id: row.id,
    slug: row.slug,
    catalogSlug: row.catalog_service_slug ?? null,
    label: row.label ?? row.slug,
    active: row.is_active,
    status: row.status,
    credentialMissing: row.credential_missing,
  };
}

/** The identity and effective service connections returned by NyxID Agent Key auth. */
export const agentKeyResponse = z.object({
  credential_id: id,
  credential_expires_at: z.string().nullish(),
  api_key: z.object({
    id,
    name: z.string().optional(),
    owner_id: id,
    owner_type: id.optional(),
    scopes: z.string(),
    expires_at: z.string().nullish(),
    allow_all_services: z.boolean(),
    allow_auto_connected_services: z.boolean(),
    allow_all_nodes: z.boolean(),
    allowed_node_ids: z.array(id),
    allowed_service_ids: z.array(id),
    effective_services: z.array(service),
  }),
});

export function agentIdentity(response: z.infer<typeof agentKeyResponse>) {
  const key = response.api_key;
  return {
    keyId: key.id,
    name: key.name,
    ownerId: key.owner_id,
    ownerType: key.owner_type,
    credentialId: response.credential_id,
    credentialExpiresAt: response.credential_expires_at ?? null,
    keyExpiresAt: key.expires_at ?? null,
    scopes: key.scopes.split(/\s+/).filter(Boolean),
    allowAllServices: key.allow_all_services,
    allowAutoConnectedServices: key.allow_auto_connected_services,
    services: key.effective_services.map(serviceConnection),
  };
}

export type AgentIdentity = ReturnType<typeof agentIdentity>;
