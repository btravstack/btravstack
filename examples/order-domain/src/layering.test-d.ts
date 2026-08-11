/**
 * The dependency rule, enforced by the package boundary rather than by review:
 * the domain is the innermost layer, so the arrow may only point at it. This
 * file fails to resolve on purpose, and `test:types` fails if it ever stops
 * failing — which is what would happen the moment someone added the
 * application layer to this package's dependencies.
 */

// @ts-expect-error — the domain layer must not be able to reach the application
// layer: order-domain does not depend on it, so the specifier does not resolve.
import type {} from "@btravstack/start-example-order-application";
