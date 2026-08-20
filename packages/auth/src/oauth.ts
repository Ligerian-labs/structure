import { Effect, Redacted } from "effect";
import { readBoundedText } from "./body.js";
import { encodeBase64Url, sha256Bytes } from "./crypto.js";
import { AuthDependencyError, AuthValidationError } from "./errors.js";
import type {
  OAuthCredentials,
  OAuthProfile,
  OAuthProviderId,
  TenantAuthConfig,
  TenantId,
} from "./model.js";

export interface OAuthTokens {
  readonly accessToken: Redacted.Redacted<string>;
  readonly tokenType?: string;
}

export interface OAuthHttpClient {
  readonly execute: (request: Request) => Effect.Effect<Response, AuthDependencyError>;
}

export interface OAuthProvider {
  readonly id: OAuthProviderId;
  readonly credentials: OAuthCredentials;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scopes: ReadonlyArray<string>;
  readonly tokenAuthMethod: "client-secret-basic" | "client-secret-post";
  readonly fetchProfile: (
    tokens: OAuthTokens,
    client: OAuthHttpClient,
  ) => Effect.Effect<OAuthProfile, AuthDependencyError>;
}

export interface OAuthProviderResolver {
  readonly resolve: (
    tenantId: TenantId,
    provider: OAuthProviderId,
    config: TenantAuthConfig,
  ) => Effect.Effect<OAuthProvider | undefined, AuthDependencyError>;
}

export interface AccountLinkRequest {
  readonly tenantId: TenantId;
  readonly provider: OAuthProviderId;
  readonly providerSubject: string;
  readonly profile: OAuthProfile;
  readonly existingUserId: string;
  readonly requestedByUserId?: string;
}

export interface AccountLinkPolicy {
  readonly authorize: (request: AccountLinkRequest) => Effect.Effect<boolean, AuthDependencyError>;
}

export const denyAccountLinking: AccountLinkPolicy = {
  authorize: () => Effect.succeed(false),
};

export const fetchOAuthHttpClient = (timeoutMillis = 10_000): OAuthHttpClient => ({
  execute: (request) =>
    Effect.tryPromise({
      try: () => fetch(new Request(request, { signal: AbortSignal.timeout(timeoutMillis) })),
      catch: (cause) =>
        new AuthDependencyError({ dependency: "oauth-http", operation: "request", cause }),
    }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (
  value: unknown,
  field: string,
): Effect.Effect<string, AuthDependencyError> =>
  typeof value === "string" && value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new AuthDependencyError({ dependency: "oauth-provider", operation: `decode-${field}` }),
      );

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const json = (response: Response, operation: string): Effect.Effect<unknown, AuthDependencyError> =>
  Effect.gen(function* () {
    if (!response.ok) {
      return yield* new AuthDependencyError({
        dependency: "oauth-provider",
        operation: `${operation}-http-${response.status}`,
      });
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > 1_048_576) {
      return yield* new AuthDependencyError({
        dependency: "oauth-provider",
        operation: `${operation}-response-too-large`,
      });
    }
    const body = yield* Effect.tryPromise({
      try: () => readBoundedText(response.body, 1_048_576),
      catch: (cause) => new AuthDependencyError({ dependency: "oauth-provider", operation, cause }),
    });
    return yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (cause) =>
        new AuthDependencyError({
          dependency: "oauth-provider",
          operation: `${operation}-json`,
          cause,
        }),
    });
  });

const bearerRequest = (url: string, token: Redacted.Redacted<string>): Request =>
  new Request(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${Redacted.value(token)}`,
      "user-agent": "structure-auth",
    },
  });

const oidcProfile =
  (url: string) =>
  (
    tokens: OAuthTokens,
    client: OAuthHttpClient,
  ): Effect.Effect<OAuthProfile, AuthDependencyError> =>
    Effect.gen(function* () {
      const body = yield* client
        .execute(bearerRequest(url, tokens.accessToken))
        .pipe(Effect.flatMap((response) => json(response, "userinfo")));
      if (!isRecord(body)) {
        return yield* new AuthDependencyError({
          dependency: "oauth-provider",
          operation: "decode-userinfo",
        });
      }
      const subject = yield* requiredString(body.sub, "subject");
      const email = optionalString(body.email)?.trim().toLowerCase();
      const displayName = optionalString(body.name);
      return {
        subject,
        ...(email === undefined ? {} : { email }),
        emailVerified: body.email_verified === true,
        ...(displayName === undefined ? {} : { displayName }),
      };
    });

const githubProfile = (
  tokens: OAuthTokens,
  client: OAuthHttpClient,
): Effect.Effect<OAuthProfile, AuthDependencyError> =>
  Effect.gen(function* () {
    const body = yield* client
      .execute(bearerRequest("https://api.github.com/user", tokens.accessToken))
      .pipe(Effect.flatMap((response) => json(response, "github-user")));
    if (!isRecord(body)) {
      return yield* new AuthDependencyError({
        dependency: "oauth-provider",
        operation: "decode-github-user",
      });
    }
    const subject =
      typeof body.id === "number" || typeof body.id === "string"
        ? String(body.id)
        : yield* requiredString(undefined, "subject");
    let email = optionalString(body.email)?.trim().toLowerCase();
    let emailVerified = false;
    const emailsBody = yield* client
      .execute(bearerRequest("https://api.github.com/user/emails", tokens.accessToken))
      .pipe(Effect.flatMap((response) => json(response, "github-emails")));
    if (Array.isArray(emailsBody)) {
      const selected = emailsBody.find(
        (candidate) =>
          isRecord(candidate) &&
          candidate.primary === true &&
          candidate.verified === true &&
          typeof candidate.email === "string",
      );
      if (isRecord(selected) && typeof selected.email === "string") {
        email = selected.email.trim().toLowerCase();
        emailVerified = true;
      }
    }
    const displayName = optionalString(body.name) ?? optionalString(body.login);
    return {
      subject,
      ...(email === undefined ? {} : { email }),
      emailVerified,
      ...(displayName === undefined ? {} : { displayName }),
    };
  });

const xProfile = (
  tokens: OAuthTokens,
  client: OAuthHttpClient,
): Effect.Effect<OAuthProfile, AuthDependencyError> =>
  Effect.gen(function* () {
    const body = yield* client
      .execute(
        bearerRequest(
          "https://api.x.com/2/users/me?user.fields=id,name,username,verified",
          tokens.accessToken,
        ),
      )
      .pipe(Effect.flatMap((response) => json(response, "x-user")));
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    if (data === undefined) {
      return yield* new AuthDependencyError({
        dependency: "oauth-provider",
        operation: "decode-x-user",
      });
    }
    const displayName = optionalString(data.name);
    return {
      subject: yield* requiredString(data.id, "subject"),
      emailVerified: false,
      ...(displayName === undefined ? {} : { displayName }),
    };
  });

const builtIn = (
  provider: "google" | "github" | "x" | "linkedin",
  credentials: OAuthCredentials,
): OAuthProvider => {
  switch (provider) {
    case "google":
      return {
        id: provider,
        credentials,
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        scopes: ["openid", "email", "profile"],
        tokenAuthMethod: "client-secret-post",
        fetchProfile: oidcProfile("https://openidconnect.googleapis.com/v1/userinfo"),
      };
    case "github":
      return {
        id: provider,
        credentials,
        authorizationEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        scopes: ["read:user", "user:email"],
        tokenAuthMethod: "client-secret-post",
        fetchProfile: githubProfile,
      };
    case "x":
      return {
        id: provider,
        credentials,
        authorizationEndpoint: "https://twitter.com/i/oauth2/authorize",
        tokenEndpoint: "https://api.x.com/2/oauth2/token",
        scopes: ["tweet.read", "users.read", "offline.access"],
        tokenAuthMethod: "client-secret-basic",
        fetchProfile: xProfile,
      };
    case "linkedin":
      return {
        id: provider,
        credentials,
        authorizationEndpoint: "https://www.linkedin.com/oauth/v2/authorization",
        tokenEndpoint: "https://www.linkedin.com/oauth/v2/accessToken",
        scopes: ["openid", "profile", "email"],
        tokenAuthMethod: "client-secret-post",
        fetchProfile: oidcProfile("https://api.linkedin.com/v2/userinfo"),
      };
  }
};

export const builtInOAuthProvider = (
  config: TenantAuthConfig,
  provider: OAuthProviderId,
): OAuthProvider | undefined => {
  if (provider === "google") {
    return config.oauth?.google === undefined ? undefined : builtIn("google", config.oauth.google);
  }
  if (provider === "github") {
    return config.oauth?.github === undefined ? undefined : builtIn("github", config.oauth.github);
  }
  if (provider === "x") {
    return config.oauth?.x === undefined ? undefined : builtIn("x", config.oauth.x);
  }
  if (provider === "linkedin") {
    return config.oauth?.linkedin === undefined
      ? undefined
      : builtIn("linkedin", config.oauth.linkedin);
  }
  return undefined;
};

export const defaultOAuthProviderResolver: OAuthProviderResolver = {
  resolve: (_tenantId, provider, config) => Effect.succeed(builtInOAuthProvider(config, provider)),
};

export const pkceChallenge = (verifier: string): Effect.Effect<string, AuthDependencyError> =>
  sha256Bytes(new TextEncoder().encode(verifier)).pipe(Effect.map(encodeBase64Url));

export const exchangeOAuthCode = (
  provider: OAuthProvider,
  client: OAuthHttpClient,
  input: {
    readonly code: string;
    readonly codeVerifier: Redacted.Redacted<string>;
    readonly redirectUri: string;
  },
): Effect.Effect<OAuthProfile, AuthDependencyError> =>
  Effect.gen(function* () {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: Redacted.value(input.codeVerifier),
    });
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    });
    if (provider.tokenAuthMethod === "client-secret-basic") {
      const formEncode = (value: string): string =>
        new URLSearchParams({ value }).toString().slice("value=".length);
      headers.set(
        "authorization",
        `Basic ${btoa(
          `${formEncode(provider.credentials.clientId)}:${formEncode(
            Redacted.value(provider.credentials.clientSecret),
          )}`,
        )}`,
      );
    } else {
      body.set("client_id", provider.credentials.clientId);
      body.set("client_secret", Redacted.value(provider.credentials.clientSecret));
    }
    const tokenBody = yield* client
      .execute(new Request(provider.tokenEndpoint, { method: "POST", headers, body }))
      .pipe(Effect.flatMap((response) => json(response, "token-exchange")));
    if (!isRecord(tokenBody)) {
      return yield* new AuthDependencyError({
        dependency: "oauth-provider",
        operation: "decode-token-response",
      });
    }
    const accessToken = yield* requiredString(tokenBody.access_token, "access-token");
    const tokenType = optionalString(tokenBody.token_type);
    return yield* provider.fetchProfile(
      {
        accessToken: Redacted.make(accessToken),
        ...(tokenType === undefined ? {} : { tokenType }),
      },
      client,
    );
  });

export const validateReturnTo = (
  config: TenantAuthConfig,
  returnTo: string | undefined,
): Effect.Effect<string | undefined, AuthValidationError> => {
  if (returnTo === undefined) return Effect.succeed(undefined);
  return Effect.try({
    try: () => {
      const resolved = new URL(returnTo, config.baseUrl);
      if (resolved.origin !== config.baseUrl.origin) throw new Error("cross-origin return URL");
      return resolved.toString();
    },
    catch: () =>
      new AuthValidationError({
        field: "returnTo",
        reason: "must resolve to the tenant base URL origin",
      }),
  });
};
