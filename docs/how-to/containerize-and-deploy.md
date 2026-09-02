---
title: Containerize and deploy
description: "A multi-stage Dockerfile, one image for every deployment, a Deployment manifest whose grace period matches the drain, probes on the kernel's own port, and migrations as a Job that runs before the rollout."
---

# Containerize and deploy

> **How-to.** Take an application from `runMain` to a running pod: build one
> image, run each deployment from it, wire the probes to the kernel's own
> server, and make the grace period agree with the drain. For _why_ the drain
> has three beats, see
> [Draining, in three beats](/explanation/draining-in-three-beats); for the
> knobs, [Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes).

The defaults in this framework are shaped for a cluster — `HOST=0.0.0.0`
because a pod is not a laptop, a pre-drain delay because endpoint removal is
eventually consistent, a probe server that is up before the graph is. This page
is the deployment those defaults were designed against.

## One image, every deployment

**One process boots one runtime**, so an API, a worker and a consumer are three
Deployments — and they are three _entry points of one image_, not three images.
Nothing in the build is transport-specific:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# The lockfile and manifests first: this layer is cached until a dependency
# actually changes, which is the difference between a 4-second and a
# 90-second rebuild on a code-only commit.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm build
# `pnpm deploy` writes a self-contained directory with the workspace's own
# build output and its PRODUCTION dependencies only — the compiler, the test
# harness and every other devDependency stay in this stage.
RUN pnpm --filter @acme/orders deploy --prod --legacy /out

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
# `node`, not root: the image ships a `node` user for exactly this.
USER node
# No entry point: each Deployment names the one it boots.

# The migration image is the BUILD stage, which still has the Prisma CLI and
# the schema — a `migrate deploy` needs both, and neither belongs in the image
# that serves traffic.
FROM build AS migrate
WORKDIR /app
CMD ["npx", "prisma", "migrate", "deploy"]
```

::: tip
`runMain` sets `process.exitCode` and lets Node exit on its own, so **no
`--init` and no `tini` is needed** to make the process reap correctly — but
the container must receive the signal, which means the exec form
(`command: ["node", "dist/main.js"]`), never a shell wrapper that would swallow
SIGTERM.
:::

## The Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
spec:
  replicas: 3
  selector:
    matchLabels: { app: orders-api }
  template:
    metadata:
      labels: { app: orders-api }
    spec:
      # > PRE_DRAIN_DELAY_MS + DRAIN_TIMEOUT_MS, with headroom for `stopping`.
      terminationGracePeriodSeconds: 60
      containers:
        - name: api
          image: registry.example.com/orders:1.4.0
          # The exec form: the signal reaches node, not a shell.
          command: ["node", "dist/main.js"]
          ports:
            - { name: http, containerPort: 8080 }
            - { name: probes, containerPort: 9000 }
          env:
            - { name: PORT, value: "8080" }
            - { name: HOST, value: "0.0.0.0" }
            - { name: PRE_DRAIN_DELAY_MS, value: "10000" }
            - { name: DRAIN_TIMEOUT_MS, value: "40000" }
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: orders, key: database-url }
          livenessProbe:
            httpGet: { path: /livez, port: probes }
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /readyz, port: probes }
            periodSeconds: 2
          startupProbe:
            httpGet: { path: /livez, port: probes }
            failureThreshold: 30
            periodSeconds: 2
```

Four things in there are the framework's own decisions, not boilerplate:

**The probes are on their own port.** The kernel runs a `node:http` server
separate from the runtime, so `/livez` and `/readyz` are never exposed on the
Service that serves traffic — and a Temporal worker with no HTTP port gets the
same probes. Only `http` goes in the Service.

**`readinessProbe` is polled often, on purpose.** Beat 1 of the drain flips
readiness `false` synchronously, and beat 2 then waits `PRE_DRAIN_DELAY_MS`
before the runtime stops accepting. That delay only buys anything if the
kubelet notices in the meantime: `periodSeconds: 2` against a 10-second
pre-drain delay gives it five chances.

**`startupProbe` points at `/livez`, not `/readyz`.** The probe server binds
_before_ the graph is built, so `/livez` answers `200` while construction is
still running — a slow migration check or a cold connection pool is a pod that
is starting, not a pod that is broken.

**The grace period and the drain move together.** `terminationGracePeriodSeconds`
must exceed `PRE_DRAIN_DELAY_MS + DRAIN_TIMEOUT_MS` with room for `stopping`;
raise one and raise the other, in this same file. Below it, the kubelet stops
waiting before the kernel does, and whatever was in flight is lost _and_ never
reported.

## The other two deployments

Same image, another command — one entry point per deployment, each a
`runMain` of a different composition root, all built by the same `pnpm build`:

```yaml
# orders-worker: the Temporal deployment
command: ["node", "dist/worker-main.js"]
env:
  - { name: TEMPORAL_ADDRESS, value: "temporal.svc.cluster.local:7233" }
  - { name: TEMPORAL_NAMESPACE, value: "orders" }
```

```yaml
# orders-consumer: the AMQP deployment
command: ["node", "dist/consumer-main.js"]
env:
  - name: AMQP_URL
    valueFrom:
      secretKeyRef: { name: orders, key: amqp-url }
```

Each scales, fails and deploys on its own — which is the point of
[one process, one runtime](/explanation/one-process-one-runtime). A worker that
falls behind gets replicas without giving the API any, and a crash in the
consumer takes nothing else down.

## Migrations run before the rollout, not at boot

An application that migrates itself at startup races every other replica: three
pods, three migrations, one of them losing. Run it once, as a Job, and let the
rollout wait for it:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: orders-migrate-1.4.0
spec:
  backoffLimit: 3
  # Cleans itself up an hour after it finishes, so the next release's Job is
  # not blocked by this one's leftovers.
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          # The `migrate` target, not the runtime one: `migrate deploy` needs
          # the Prisma CLI and the schema, and neither is in the image that
          # serves traffic.
          image: registry.example.com/orders:1.4.0-migrate
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: orders, key: database-url }
```

**A Job is immutable once created** — neither `metadata.name` nor the pod
template can be changed by a re-apply — which is why the name carries the
version: each release applies a _new_ Job rather than trying to update a
completed one. (`generateName` is the alternative when a release has no version
string to hang it on.) In a pipeline: apply the Job, wait for it, then apply the
Deployment — waiting on **both** conditions, since `kubectl wait` defaults to
30 seconds and only ever watches the one you name:

```sh
kubectl apply -f migrate-job.yaml

# Whichever lands first wins; without the `failed` watch, a Job that died in
# ten seconds is only noticed when the timeout expires — and a slow image pull
# looks identical to it.
kubectl wait --for=condition=complete --timeout=10m job/orders-migrate-1.4.0 &
complete=$!
kubectl wait --for=condition=failed --timeout=10m job/orders-migrate-1.4.0 && exit 1 &
failed=$!
wait -n "$complete" "$failed"

kubectl apply -f deployment.yaml
```

::: warning
An `initContainer` looks like the tidier answer and is not: it runs **once per
pod**, so three replicas is three concurrent `migrate deploy` invocations
against one database, and a rolling update runs them again on every new pod.
Use it only for a single-replica deployment.
:::

## What the pod does on SIGTERM

The three beats, as they appear from the cluster's side:

1. **Readiness flips `false`** and the open unit count is sampled — the
   endpoint controller starts removing this pod from the Service.
2. **`PRE_DRAIN_DELAY_MS`** passes with the runtime still accepting, because
   endpoint removal is eventually consistent: the ingress may still be routing
   here, and a pod that stopped accepting instantly would reject that traffic.
3. **`DRAIN_TIMEOUT_MS`** for in-flight work; whatever is still open is
   aborted and reported `abandoned`, which is exit code `2`.

A clean drain exits `0`. An exit `2` in your logs means work was cut off —
either the grace period is too tight or something is holding a unit open. The
other codes are in [Exit codes](/reference/core/exit-codes).

## Where to go next

- Size the knobs: [Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes).
- Everything the environment configures:
  [Configure from the environment](/how-to/configure-from-the-environment).
- Three deployments on one laptop:
  [Run several deployments locally](/how-to/run-several-deployments-locally).
