import type { LicenseCapabilities } from './license.js';

/** SA §6.1：platform ⊃ organization ⊃ course；self 為非傳遞例外（ADR-016） */
export type ScopeType = 'platform' | 'organization' | 'course' | 'self';

export interface ScopeGrant {
  type: ScopeType;
  /** platform 為 null；organization 為 org id；course 為 course id；self 為 user id */
  id: string | null;
  organizationId: string | null;
}

/** GET /api/me（openapi.yaml#/components/schemas/MeResponse） */
export interface MeResponse {
  user: { id: string; email: string; displayName: string; locale: string };
  activeOrganization: { id: string; name: string; branding: Record<string, unknown> } | null;
  organizations: { id: string; name: string }[];
  permissions: string[];
  scopes: { type: ScopeType; id: string | null }[];
  licenseCapabilities: LicenseCapabilities;
}
