/**
 * What makes a contract a *shared* artifact, enforced by the package boundary
 * rather than by review: a client has to be able to take the contract without
 * the server that implements it — the router, its di wiring, its persistence,
 * the kernel. This file fails to resolve on purpose, and `test:types` fails if
 * it ever stops failing, which is what would happen the moment someone added
 * the transport package to this package's dependencies.
 */

// @ts-expect-error — the contract must not be able to reach the server that
// implements it: order-api-contract does not depend on order-api, so the
// specifier does not resolve.
import type {} from "@btravstack/example-order-api";
