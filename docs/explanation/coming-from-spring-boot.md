---
title: Coming from Spring Boot
description: "What maps — starters, constructor injection, graceful shutdown, actuator probes — and the four things that have no equivalent: no reflection, no profiles, one runtime per process, and no @Scheduled without Temporal."
---

# Coming from Spring Boot

> **Explanation.** What a Spring Boot developer already holds that carries over,
> and — the half that matters on day two — what has **no** equivalent here. For
> the design behind the differences, start with
> [Why btravstack?](/explanation/why-btravstack).

Spring Boot is the nearest neighbour this framework has. The starter idea is
taken from it on purpose: a package that brings one concern's defaults for the
standard case, composed by adding it and configured by the environment. If you
have written `spring-boot-starter-web`, `@ConfigurationProperties` and a
`@PreDestroy`, most of this will read as familiar with the reflection removed.

## What maps

| Spring Boot                                                                | btravstack                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `spring-boot-starter-*`                                                    | `@btravstack/*` starters — `http-server`, `temporal-worker`, `amqp-worker`, `cache`, `mailer` |
| Constructor injection                                                      | `Provider(Port)({ inject: { name: Dep }, sync })` — dependencies named by key                 |
| `@Bean` in a `@Configuration`                                              | a provider in a module's `provides`                                                           |
| A bean's type as its identity                                              | a **port**: `class Cache extends Port("Cache")<Service> {}` — nominal, never structural       |
| `@ConfigurationProperties` + JSR-380 validation                            | `Config.object({ … })` bound to a port, validated once as the graph builds                    |
| Actuator's `/actuator/health`, `/readiness`                                | the kernel's own probe server: `/livez`, `/readyz`, `/healthz`                                |
| `server.shutdown=graceful` + `spring.lifecycle.timeout-per-shutdown-phase` | the three-beat drain: `PRE_DRAIN_DELAY_MS`, `DRAIN_TIMEOUT_MS`                                |
| `@PreDestroy` / `DisposableBean`                                           | a resourceful provider's `release`, run on every exit path                                    |
| `HealthIndicator`                                                          | a `HealthChecks` member a starter contributes, folded into `/healthz`                         |
| `@MockBean` in a slice test                                                | `overridden(root, [provider])` — the double typed against the port                            |

Two of those are closer than they look. A **starter** here is the same bargain:
compose `http()` and you get a runtime, a config port bound from `PORT`/`HOST`,
and a drain that stops accepting before it stops running — none of which you
wrote. And `Config.object` is `@ConfigurationProperties` with the validation
non-optional: the **validated object is the injected value**, so a field that
is not in the schema is not a key returning `null`, it is a property that does
not exist.

## What has no equivalent

This is the half a comparison table usually leaves out, and it is what you hit
in week one.

### No reflection, no classpath scanning, no proxies

There is no `@ComponentScan`, because there is nothing to scan: a module names
its providers as values, and a provider names its dependencies by key. There is
no `@Autowired`, no field injection and no proxy — a service is the object your
factory returned, so `this` means what it says and a stack trace has no
`$$EnhancerBySpringCGLIB$$` frame in it.

The compensation is that wiring is checked by `tsc` rather than at startup: a
port nothing provides is a compile error naming the port, before the process
exists. See [Compile errors, not surprises](/explanation/compile-time-wiring).

### No profiles, no `application-{env}.yml`, no property sources

There is no `@Profile`, no profile-specific file, and no layered property
resolution. Configuration is **the environment**, read through `Config`, and
what varies per deployment is a variable — that is
[twelve-factor](https://12factor.net/config) taken literally rather than
partially. A value that is a _decision_ rather than a deployment's is pinned in
code at the composition root (`http({ cors: false })`), where it is visible and
type-checked, instead of living in a YAML file that ships in the image.

What that costs: no `@Value("${...}")` sprinkled through the code, no
`Environment` bean to read ad hoc, and no encrypted property source. Secrets
come from the platform — a `secretKeyRef`, a mounted file read at boot — the
same way a Spring deployment on Kubernetes usually ends up doing it anyway.

### One runtime per process

A Spring Boot application is comfortable serving HTTP, consuming from Rabbit
and running `@Scheduled` methods in one JVM. Here that is **three deployments**
of one image, each booting one runtime: an API, a worker, a consumer. They
scale, fail and deploy independently, which is what a cluster wants — and it
deletes the question of whose failure takes the process down.

The consequence to plan for: work you would have done in a `@Scheduled` method
beside a controller now lives in a different process, and reaches the same
application module through the same ports. See
[One process, one runtime](/explanation/one-process-one-runtime).

### No `@Scheduled`, and no scheduler coming

There is no cron in this framework, and none is planned. Scheduled work is
[Temporal](/reference/temporal-worker)'s — a Schedule, with retries, a history
and an idempotency story a `@Scheduled` method in one replica of three does not
have. The honest version of this trade: adding a scheduled job costs you a
Temporal service where Spring costs you an annotation, and what you get for it
is a job that runs once across replicas and can be replayed.

See [Run something on a schedule](/how-to/run-something-on-a-schedule).

### No filter chain, no interceptors, no AOP

There is no `HandlerInterceptor`, no `OncePerRequestFilter`, no
`@Transactional` and no aspect. Cross-cutting concerns are **configuration** on
the starter — CORS, body limits, compression, security headers, authentication
are named options — and everything else is an ordinary function call in the
handler. A transaction is spelled at the call in the adapter that owns the
connection; there is no ambient one to join.

The one hole this leaves honestly: a genuinely global behaviour that is not on
the option list is an oRPC plugin (an escape hatch that exists and is
documented), not a slot this framework invented.

### Exceptions are not the error channel

Spring's `@ExceptionHandler` / `@ControllerAdvice` turns a thrown exception into
a response. Here a failure is a **value** — an `unthrown` `Result` — and the one
place it becomes a status code is the router's own triage, which the compiler
checks for exhaustiveness. A `throw` is a _defect_: unmodelled, reported, and
never something a handler catches to make a nice 400 out of. See
[Nothing throws](/explanation/nothing-throws).

## What Spring Boot does better

Worth saying plainly, since the rest of this page is one-directional.

**Breadth.** Spring has a starter for nearly everything, and this framework has
six. If your application needs LDAP, Kafka, batch processing and a message
converter you have not thought about yet, Spring already has it.

**Ecosystem maturity.** Twenty years of answers to questions you have not asked
yet, and every one of them on Stack Overflow.

**A scheduler in the box.** `@Scheduled` costs an annotation. The Temporal
answer is better under load and much heavier to start.

## Where to go next

- The tutorial, which is about an hour:
  [Getting started](/tutorial/getting-started).
- The other neighbour: [Coming from NestJS](/explanation/coming-from-nestjs).
- Why the container is what it is:
  [Compile errors, not surprises](/explanation/compile-time-wiring).
