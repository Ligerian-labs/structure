import { Settings } from "@structure-ai/config";
import { Effect, Option } from "effect";
import type { OidcProviderConfig } from "./oidc.js";
import type { IdentityProvisionRequest } from "./service.js";

/**
 * Settings for one generic external OIDC identity provider. `jit` defaults
 * to `false`: with JIT off, only already-known identities sign in — enabling
 * it is a deliberate, sanctioned account entrance. `defaultTenantId` bounds
 * where JIT may create accounts; unset means "the tenant the flow started
 * in".
 */
export const oidcSettings = Settings.struct({
  issuer: Settings.url("OIDC_ISSUER_URL", {
    description: "external OIDC issuer URL (discovery at /.well-known/openid-configuration)",
  }),
  clientId: Settings.string("OIDC_CLIENT_ID", { description: "OIDC client id" }),
  clientSecret: Settings.secret("OIDC_CLIENT_SECRET", {
    description: "OIDC client secret",
  }),
  jit: Settings.boolean("OIDC_JIT_PROVISIONING", {
    description: "provision unknown identities into the default tenant (deliberate; default off)",
    default: false,
  }),
  defaultTenantId: Settings.optional(
    Settings.string("OIDC_JIT_DEFAULT_TENANT", {
      description: "tenant where JIT-provisioned accounts land; unset = the flow's tenant",
    }),
  ),
  label: Settings.optional(
    Settings.string("OIDC_LABEL", {
      description: "login button label / branding for this provider",
    }),
  ),
});

export type OidcSettingsValue =
  (typeof oidcSettings)["config"] extends import("effect").Config.Config<infer A> ? A : never;

/** Maps a loaded `oidcSettings` value to `discoverOidc` input + branding. */
export const oidcProviderConfig = (
  settings: OidcSettingsValue,
): OidcProviderConfig & { readonly label?: string } => ({
  issuer: settings.issuer,
  credentials: {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
  },
  ...(Option.isSome(settings.label) ? { label: Option.getOrThrow(settings.label) } : {}),
});

/**
 * The provisioning gate for `makeAuth({ identityProvisioning })`: JIT must
 * be enabled AND the flow must target the configured default tenant (when
 * one is set). Unknown identities never slip in through a second tenant.
 */
export const oidcProvisioningPolicy = (
  settings: OidcSettingsValue,
): { readonly allow: (request: IdentityProvisionRequest) => Effect.Effect<boolean> } => ({
  allow: (request) =>
    Effect.succeed(
      settings.jit &&
        (Option.isNone(settings.defaultTenantId) ||
          request.tenantId === Option.getOrThrow(settings.defaultTenantId)),
    ),
});
