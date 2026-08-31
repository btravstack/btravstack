import { isAuthenticated, type Requirements } from "@btravstack/contract";
import type { RouterContract } from "@orpc/contract";
import { StandardJsonSchemaConverter } from "@orpc/json-schema";
import { OpenAPIGenerator } from "@orpc/openapi";
import { fromSafePromise, type AsyncResult } from "unthrown";

/**
 * The OpenAPI document, as `@orpc/openapi` returns it.
 *
 * **Exported so a consumer can name it.** Its constituent types come from
 * `@hey-api/spec-types`, a transitive dependency nothing here depends on
 * directly, so an application annotating nothing gets TS4023 in its own
 * declaration emit — measured on `examples/order-api`. Re-exporting the alias
 * gives that application a name it owns a path to.
 */
export type OpenApiDocument = Awaited<ReturnType<OpenAPIGenerator["generate"]>>;

/**
 * The document's own `components.securitySchemes` shape, reached by index off
 * `OpenApiDocument` for the same TS4023 reason that alias exists: the real
 * type lives in `@hey-api/spec-types`, which no consumer depends on directly.
 */
export type OpenApiSecuritySchemes = NonNullable<
  NonNullable<OpenApiDocument["components"]>["securitySchemes"]
>;

export type OpenApiOptions = {
  /**
   * What each scheme the contract names actually IS — `{ type: "http", scheme:
   * "bearer" }` and the like, verbatim into `components.securitySchemes`.
   *
   * The split is the same one `defineHttp({ authenticators })` makes, and for
   * the same reason: the contract says WHICH schemes protect a route, and it
   * deliberately says nothing about what they resolve to. A scheme named by the
   * contract with no definition here still appears in `security` — a reader of
   * the document sees the requirement and an unresolvable reference, which is a
   * louder fault than silently dropping the requirement.
   */
  readonly securitySchemes?: Readonly<OpenApiSecuritySchemes>;
  /** Merged into the document — `info`, `servers`, and anything else OpenAPI takes. */
  readonly base?: Partial<OpenApiDocument>;
};

/**
 * Every procedure path in the contract, with the requirements in force at it.
 * Nearest mark wins, which is OpenAPI's own rule and the same fold
 * `Effective<C, R>` performs in the types.
 */
const requirementsByPath = (
  node: unknown,
  inherited: Requirements | undefined,
  path: readonly string[],
  into: Map<string, Requirements>,
): void => {
  if (typeof node !== "object" || node === null) return;

  const own = isAuthenticated(node) ?? inherited;

  // A procedure is a leaf: it has no child contract nodes to walk. `~orpc`
  // is oRPC's own marker on a built procedure, which is what tells the two
  // apart without importing its internals.
  const children = Object.entries(node as Record<string, unknown>).filter(
    ([key, value]) => !key.startsWith("~") && typeof value === "object" && value !== null,
  );
  const isProcedure = "~orpc" in (node as Record<string, unknown>);

  if (isProcedure) {
    if (own !== undefined && path.length > 0) into.set(path.join("."), own);
    return;
  }

  for (const [key, value] of children) requirementsByPath(value, own, [...path, key], into);
};

/**
 * The contract as an OpenAPI document, with the `@btravstack/contract` marker
 * folded into each operation's `security`.
 *
 * ```ts
 * const document = (
 *   await openApiDocument(contract, {
 *     base: { info: { title: "Orders", version: "1.0.0" } },
 *     securitySchemes: { user: { type: "http", scheme: "bearer" } },
 *   })
 * ).get();
 * ```
 *
 * **The marker IS OpenAPI's shape**, which is why this is a fold rather than a
 * translation: `Requirement` is `Record<scheme, scopes[]>` and `Requirements`
 * is an array of them — exactly `SecurityRequirementObject[]`, where keys
 * within one object are AND and separate objects are OR. That correspondence is
 * the reason `@btravstack/contract` refuses a two-scheme requirement it would
 * otherwise run as OR.
 *
 * Operations are matched by **`operationId`**, which `@orpc/openapi` defaults to
 * the router segments joined by `.` — the same dotted path the contract tree
 * gives. Set `operationId` yourself on a procedure and its requirement is still
 * found, because the walk keys on the contract's own path, not on the document's.
 */
export const openApiDocument = (
  contract: Record<string, RouterContract>,
  options: OpenApiOptions = {},
): AsyncResult<OpenApiDocument, never> => {
  const generator = new OpenAPIGenerator({ converters: [new StandardJsonSchemaConverter()] });
  return fromSafePromise(generator.generate(contract, { base: options.base })).map((document) => {
    const byPath = new Map<string, Requirements>();
    requirementsByPath(contract, undefined, [], byPath);
    if (byPath.size === 0 && options.securitySchemes === undefined) return document;

    for (const item of Object.values(document.paths ?? {})) {
      for (const operation of Object.values(item as Record<string, { operationId?: string }>)) {
        const requirements = byPath.get(operation.operationId ?? "");
        if (requirements !== undefined) {
          (operation as { security?: unknown }).security = requirements.map((r) => ({ ...r }));
        }
      }
    }

    if (options.securitySchemes !== undefined) {
      document.components = {
        ...document.components,
        securitySchemes: { ...options.securitySchemes },
      };
    }

    return document;
  });
};
