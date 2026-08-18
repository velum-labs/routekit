import type {
  IssuedToken,
  TokenListEntry,
  TokenPlane,
  TokenPrincipal,
  TokenRole
} from "@velum-labs/routekit-runtime/tokens";
import { createTokenStore } from "@velum-labs/routekit-runtime/tokens";
import {
  RouteKitFailure,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Context, Effect, Layer } from "effect";

import { dataTokenPath } from "../../daemon-maintenance.js";

export type IssueTokenInput = {
  label: string;
  plane: TokenPlane;
  role?: TokenRole;
  createdBy?: string;
  plaintext?: string;
};

export type TokensService = {
  readonly dataAuth: { readonly token: string; readonly path: string };
  issue(input: IssueTokenInput): Effect.Effect<IssuedToken, RouteKitFailure>;
  list(plane?: TokenPlane): Effect.Effect<TokenListEntry[], RouteKitFailure>;
  revoke(id: string): Effect.Effect<TokenListEntry, RouteKitFailure>;
  resolve(presented: string, plane?: TokenPlane): TokenPrincipal | undefined;
  dataTokenForPrincipal(
    principal: { id: string; label: string; role: string } | undefined
  ): Effect.Effect<string, RouteKitFailure>;
};

export type TokensLayerOptions = {
  readonly home: string;
  readonly authToken?: string;
  readonly authTokenFile?: string;
};

/** Owns the token store, owner credential, and derived data-token cache. */
export class Tokens extends Context.Service<Tokens, TokensService>()(
  "@velum-labs/routekit-daemon/Tokens"
) {
  static layer(options: TokensLayerOptions): Layer.Layer<Tokens, RouteKitFailure> {
    return Layer.effect(
      Tokens,
      Effect.try({
        try: () => {
          const store = createTokenStore(options.home);
          const plaintextPath = options.authTokenFile ?? dataTokenPath(options.home);
          const dataAuth = store.ensureOwnerDataToken({
            ...(options.authToken === undefined ? {} : { plaintext: options.authToken }),
            plaintextPath
          });
          const derivedDataTokens = new Map<string, { readonly id: string; readonly token: string }>();

          const issue = (
            input: IssueTokenInput
          ): Effect.Effect<IssuedToken, RouteKitFailure> =>
            Effect.try({
              try: () => {
                if (input.plane === "data") derivedDataTokens.delete(input.label);
                return store.issue(input);
              },
              catch: toRouteKitFailure
            });

          const revoke = (id: string): Effect.Effect<TokenListEntry, RouteKitFailure> =>
            Effect.try({
              try: () => {
                const revoked = store.revoke(id);
                if (revoked.plane === "data") derivedDataTokens.delete(revoked.label);
                return revoked;
              },
              catch: toRouteKitFailure
            });

          return Tokens.of({
            dataAuth: { token: dataAuth.token, path: plaintextPath },
            issue,
            list: (plane) =>
              Effect.try({
                try: () => store.list(plane),
                catch: toRouteKitFailure
              }),
            revoke,
            resolve: store.resolve,
            dataTokenForPrincipal: (principal) => {
              if (
                principal === undefined ||
                principal.role === "ephemeral" ||
                principal.role === "owner"
              ) {
                return Effect.succeed(dataAuth.token);
              }
              const label = `${principal.label}-data`;
              const cached = derivedDataTokens.get(label);
              if (cached !== undefined) return Effect.succeed(cached.token);
              return Effect.gen(function* () {
                const existing = store.findByLabel(label, "data");
                if (existing !== undefined) yield* revoke(existing.id);
                const issued = yield* issue({
                  label,
                  plane: "data",
                  role: "admin",
                  createdBy: principal.label
                });
                derivedDataTokens.set(label, { id: issued.id, token: issued.token });
                return issued.token;
              });
            }
          });
        },
        catch: toRouteKitFailure
      })
    );
  }
}
