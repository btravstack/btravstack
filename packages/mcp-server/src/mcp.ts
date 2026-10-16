import type { OneScheme, Requirements } from "@btravstack/contract";
import { Observers, observe, type Operation, type Settle } from "@btravstack/core";
import { Provider, type AnyPort, type Scope } from "@btravstack/di";
import {
  forkUnit,
  HttpConfig,
  HttpHandler,
  HttpUnit,
  principalOf,
  resolveScheme,
  schemeDeps,
  schemeServices,
  send,
  type Authenticators,
  type HttpAuth,
  type KindOf,
  type Kinds,
  type Principal,
  type RequiresGate,
  type Resolved,
  type SchemePortsOf,
  type SchemesFrom,
  type SchemesOf,
  type UnitFor,
  type UnitsNeedsOf,
  type UnitsOf,
} from "@btravstack/http-server/internal";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Ok, P, TaggedError, fromThrowable, type AsyncResult, type Result } from "unthrown";

/**
 * A tool's refusal, as the model reads it. A tool's own triage mints it from
 * its `E` — an exhaustive `mapErrCases` — so widening `E` fails every tool that
 * folds it, and `text` is the one thing the caller is told.
 */
export class ToolRefused extends TaggedError("ToolRefused")<{ readonly text: string }> {}

/** What a tool answers from: its value on `Ok`, a {@link ToolRefused} on `Err`. */
export type ToolOutcome<T> = AsyncResult<T, ToolRefused> | Result<T, ToolRefused>;

/**
 * What `server` is handed for one request: the caller `requires` resolved
 * (`undefined` without `requires`), the `unit` record read off the forked
 * kind, the request's abort signal, and `toolResult`, which turns a tool's
 * `Result` into the SDK's answer.
 */
export type McpContext<Principal = unknown, Unit = Readonly<Record<string, unknown>>> = {
  readonly principal: Principal;
  readonly unit: Unit;
  readonly signal: AbortSignal;
  /**
   * `Ok` is the tool's answer — text for a string, structured content beside
   * its JSON text when that JSON is an object, its JSON text alone otherwise. `Err` is a tool error carrying the
   * refusal's `text`.
   * A defect — or a value JSON cannot encode — is reported to `Observers` and
   * answered as a tool error saying nothing about its cause.
   *
   * It answers a `Promise`, and that is the boundary: the SDK's tool callback
   * answers a value or a promise, as a GraphQL resolver does for `fieldResult`.
   */
  readonly toolResult: <T>(outcome: ToolOutcome<T>) => Promise<CallToolResult>;
};

type ContextOf<
  A extends Authenticators,
  Units,
  R extends Requirements,
  U extends Readonly<Record<string, AnyPort>>,
> = McpContext<
  [R] extends [never] ? undefined : Principal<SchemesOf<R>, SchemesFrom<A>>,
  UnitFor<U, Units, KindOf<R>>
>;

type MissingUnitPorts<
  U extends Readonly<Record<string, AnyPort>>,
  Units,
  K extends string,
> = Exclude<keyof U, keyof UnitFor<U, Units, K>>;
type UnitGate<U extends Readonly<Record<string, AnyPort>>, Units, K extends string> = [
  MissingUnitPorts<U, Units, K>,
] extends [never]
  ? unknown
  : {
      readonly "UNIT PORT MISSING — the selected kind does not export": MissingUnitPorts<
        U,
        Units,
        K
      >;
    };

/** Serve an MCP server as one answerer under the existing HTTP runtime. */
export type McpOptions<
  A extends Authenticators,
  Units extends UnitsOf<A>,
  R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> },
  U extends Readonly<Record<string, AnyPort>>,
> = {
  /**
   * The SDK's own server, built for one request — `new McpServer(…)` and its
   * `registerTool` calls. Built per request because the transport is stateless:
   * no session outlives the request, so a replica can answer any of them.
   */
  readonly server: (context: ContextOf<A, Units, R, U>) => McpServer;
  readonly prefix?: `/${string}`;
  readonly units?: Units & { readonly [K in Exclude<keyof Units, Kinds<A>>]: never };
  readonly unit?: U & UnitGate<U, Units, KindOf<R>>;
  readonly requires?: R & RequiresGate<R, { readonly [K in keyof A]: A[K]["scope"] }>;
};

const DEFECT: CallToolResult = {
  content: [{ type: "text", text: "The tool failed." }],
  isError: true,
};

/** A tool's value JSON cannot encode — a `bigint`, a cycle: a defect of the tool's, reported. */
class UnencodableAnswer extends TaggedError("UnencodableAnswer")<{ readonly cause: unknown }> {}

const isRecord = (json: unknown): json is Record<string, unknown> =>
  typeof json === "object" && json !== null && !Array.isArray(json);

// `structuredContent` is an object in the specification, so it is the value's
// JSON form when that is a record — a `Date` serializes to a string and is
// text alone, as is every other value.
const answerOf = (value: unknown): Result<CallToolResult, UnencodableAnswer> =>
  typeof value === "string"
    ? Ok({ content: [{ type: "text", text: value }] })
    : // All of it inside, `String` included: a value whose JSON is `undefined`
      // can still throw on coercion, and that too is the tool's defect.
      fromThrowable(
        (): CallToolResult => {
          const json = JSON.stringify(value) as string | undefined;
          const parsed: unknown = json === undefined ? undefined : JSON.parse(json);
          return isRecord(parsed)
            ? { content: [{ type: "text", text: json! }], structuredContent: parsed }
            : { content: [{ type: "text", text: json ?? String(value) }] };
        },
        (cause) => new UnencodableAnswer({ cause }),
      )();

const toolResultFor = (observers: readonly ((operation: Operation) => Settle)[]) => {
  const defect = (cause: unknown): CallToolResult => {
    observe(observers, { component: "mcp", name: "defect", attributes: {}, traced: false })({
      outcome: "error",
      cause,
    });
    return DEFECT;
  };
  return async <T>(outcome: ToolOutcome<T>): Promise<CallToolResult> => {
    const settled = await outcome;
    if (settled.isDefect()) return defect(settled.cause);
    if (settled.isErr())
      return { content: [{ type: "text", text: settled.error.text }], isError: true };
    return answerOf(settled.value).getOrElse((unencodable) => defect(unencodable.cause));
  };
};

/**
 * An MCP server as one answerer: Streamable HTTP, stateless, answering JSON,
 * under `prefix` (default `/mcp`). The SDK owns the protocol; this owns what
 * the runtime owns for every answerer — authentication through the shared
 * schemes, the request's unit, the body limit — and nothing else.
 *
 * ```ts
 * const answerer = mcp(auth, {
 *   requires: [{ user: [] }],
 *   unit: { orders: Orders },
 *   server: ({ principal, unit, toolResult }) => {
 *     const server = new McpServer({ name: "orders", version: "1.0.0" });
 *     server.registerTool("list_orders", { inputSchema: {} }, () =>
 *       toolResult(unit.orders.list(principal.tenantId)),
 *     );
 *     return server;
 *   },
 * });
 * ```
 *
 * A caller no requirement accepts is answered `401` and an under-scoped one
 * `403`, with no body — so `protectedResource()`'s challenge rides the `401`.
 */
export const mcp = <
  A extends Authenticators,
  Units extends UnitsOf<A> = Record<never, never>,
  const R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> } = never,
  U extends Readonly<Record<string, AnyPort>> = Record<never, never>,
>(
  api: HttpAuth<A>,
  options: McpOptions<A, Units, R, U>,
) => {
  const prefix = options.prefix ?? "/mcp";
  const requirements = options.requires as Requirements | undefined;
  const schemes = [
    ...new Set(requirements?.flatMap((requirement) => Object.keys(requirement)) ?? []),
  ];
  const provider = Provider.member(HttpHandler)({
    inject: { config: HttpConfig, units: HttpUnit, observers: Observers, ...schemeDeps(schemes) },
    sync: (services) => {
      const { config, units, observers } = services;
      if (options.units !== undefined)
        for (const kind of requirements === undefined ? ["anonymous"] : schemes) {
          const declared = options.units[kind] ?? options.units["anonymous"];
          const bound = units[kind] ?? units["anonymous"];
          if (declared !== bound)
            // oxlint-disable-next-line unthrown/no-throw -- a declaration that differs from the runtime's binding is a wiring defect
            throw new Error(`[mcp-server] unit kind ${JSON.stringify(kind)} differs from HttpUnit`);
        }
      const authenticators = schemeServices(schemes, services);
      const toolResult = toolResultFor(observers);
      // The SDK refuses `0`; the runtime's `0` is "unbounded".
      const maxRequestBodySize =
        config.bodyLimit === 0 ? Number.MAX_SAFE_INTEGER : config.bodyLimit;
      return {
        prefix,
        handle: async (request, response, signal, host) => {
          let resolved: Resolved | undefined;
          if (requirements !== undefined) {
            const result = await resolveScheme(
              requirements,
              authenticators,
              request.headers,
            ).mapErrCases((matcher) =>
              matcher
                .with(P.tag("Unauthenticated"), () => 401 as const)
                .with(P.tag("UnderScoped"), () => 403 as const),
            );
            if (result.isDefect()) {
              // oxlint-disable-next-line unthrown/no-throw -- an authenticator defect belongs to the runtime's 500 path
              throw result.cause;
            }
            if (result.isErr()) {
              send(response, result.error);
              return;
            }
            resolved = result.value;
          }
          const forked = await forkUnit(host, units, api.principals, resolved, options.unit ?? {});
          if (forked.isDefect()) {
            // oxlint-disable-next-line unthrown/no-throw -- the handler has no defect channel
            throw forked.cause;
          }
          const server = options.server({
            principal:
              requirements === undefined ? undefined : principalOf(requirements, resolved!),
            unit: forked.get(),
            signal,
            toolResult,
          } as ContextOf<A, Units, R, U>);
          // No `sessionIdGenerator`: the transport is stateless, so any replica answers.
          const transport = new StreamableHTTPServerTransport({
            enableJsonResponse: true,
            maxRequestBodySize,
          });
          response.once("close", () => {
            void transport.close();
            void server.close();
          });
          // The SDK's own declarations disagree under `exactOptionalPropertyTypes`.
          await server.connect(transport as unknown as Transport);
          await transport.handleRequest(request, response);
        },
      };
    },
  });
  // `schemeDeps` is keyed at runtime, while the literal `R` carries the
  // precise port ids to di's needs gate. The two describe the same schemes.
  const typed = provider as Provider<
    InstanceType<typeof HttpHandler>,
    never,
    | InstanceType<typeof HttpConfig>
    | InstanceType<typeof HttpUnit>
    | Observers
    | UnitsNeedsOf<Units>
    | SchemePortsOf<R>
    | Scope
  >;
  return Object.assign(typed, { authenticators: api.providers, units: options.units });
};
