/**
 * What makes a contract a *shared* artifact, enforced by the package boundary
 * rather than by review: a publisher has to be able to describe what it sends
 * with nothing but the contract — not the worker that consumes it, its di
 * wiring, its persistence or the kernel. This file fails to resolve on
 * purpose, and `test:types` fails if it ever stops failing, which is what
 * would happen the moment someone added the worker package to this package's
 * dependencies.
 */

// @ts-expect-error — the contract must not be able to reach the worker that
// implements it: order-amqp-contract does not depend on order-amqp-worker, so the
// specifier does not resolve.
import type {} from "@btravstack/example-order-amqp-worker";
