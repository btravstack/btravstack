---
title: Configure a Kubernetes deployment
description: Give a deployment its variables from a ConfigMap and its secrets from a Secret, keep one overlay per environment, and rotate a value by rolling the pods.
---

# Configure a Kubernetes deployment

> **How-to.** Get every variable a deployment reads into its pods — the
> plain ones, the secret ones, and the ones that differ between staging and
> production — and change one later. For what each starter reads, see
> [Configure from the environment](/how-to/configure-from-the-environment);
> for the Deployment itself, [Containerize and deploy](/how-to/containerize-and-deploy).

The framework reads **the process environment, once, at boot** — that is the
whole contract. It has no profiles, reads no files, calls no secret store and
never reloads, and each of those is the platform's job on purpose: Kubernetes
already selects per environment, stores secrets, and replaces pods. What
follows is what that looks like.

The manifests below configure `examples/order-api`'s `OrderApi` root: every
variable it reads with no default — the database, the Redis cache, the bearer
scheme, the session cookie and the login answerer — plus the drain knobs.
Everything else it reads has a default (the full list is
[What the framework itself reads](/how-to/configure-from-the-environment#what-the-framework-itself-reads))
and is set only to change it.

## 1. What every environment shares: the base ConfigMap

The base holds **only** values that are the same in every environment — the
listener, and the drain knobs, which agree with the base Deployment's
`terminationGracePeriodSeconds`. kustomize generates the map, so each overlay
can merge into it:

```yaml
# deploy/base/kustomization.yaml
resources: ["deployment.yaml", "service.yaml"]
configMapGenerator:
  - name: orders-api
    literals:
      - PORT=8080
      - HOST=0.0.0.0
      - PRE_DRAIN_DELAY_MS=10000
      - DRAIN_TIMEOUT_MS=40000
```

Every value is a string, because an environment only carries strings — the
`Config` field on the other side is what turns `"10000"` into a number and
refuses `"10s"` by name.

**Nothing that points the pod at an environment goes here**: no identity
provider, no caller origin, no redirect URI. An overlay that merges inherits
every key it leaves out, so a value in the base is a default for every
environment — and one meant for staging, inherited by production, boots
cleanly and trusts the wrong issuer. Those live only in the overlays (step 3).

## 2. The secret ones: a Secret, referenced by key

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: orders
type: Opaque
stringData:
  database-url: "postgres://orders_app:…@db.internal:5432/orders"
  redis-url: "rediss://:…@redis.internal:6380"
  session-keys: "…"
  oidc-client-secret: "…"
```

One Secret per environment, in that environment's namespace — never in the
base. Both kinds reach the container as plain environment variables, which is
all the framework can tell apart:

```yaml
# deploy/base/deployment.yaml, the container
containers:
  - name: api
    envFrom:
      - configMapRef: { name: orders-api }
    env:
      - name: DATABASE_URL
        valueFrom:
          secretKeyRef: { name: orders, key: database-url }
      - name: REDIS_URL
        valueFrom:
          secretKeyRef: { name: orders, key: redis-url }
      - name: HTTP_SESSION_KEYS
        valueFrom:
          secretKeyRef: { name: orders, key: session-keys }
      - name: HTTP_OIDC_CLIENT_SECRET
        valueFrom:
          secretKeyRef: { name: orders, key: oidc-client-secret }
```

`secretKeyRef` per variable, rather than `envFrom: [secretRef]`, keeps the
Secret's own key names apart from the variable names, so one Secret can serve
three deployments that each read a different subset. `envFrom` on a Secret
whose keys already are variable names is the shorter equivalent.

**A secret store is reached through a Secret, not by the process.** Vault,
AWS Secrets Manager or SSM sync into a Kubernetes Secret — with the External
Secrets Operator, or the Secrets Store CSI driver's `secretObjects` — and the
Deployment references that Secret exactly as above. A value mounted only as a
**file** (a projected volume, a CSI mount with no synced Secret) is not read:
`Config` reads `Env`, and a file is something else materialising the
environment, which is the platform's half.

## 3. Profiles: one overlay per environment

What Spring calls a profile is a directory here — a base and an overlay per
environment, with [kustomize](https://kubectl.docs.kubernetes.io/references/kustomize/)
(or Helm values files, the same idea):

```text
deploy/
  base/               Deployment, Service, the shared ConfigMap of step 1
  overlays/
    staging/          every environment-specific variable, for staging
    production/       the same keys for production, plus replicas
```

Each overlay states **every** environment-specific variable, not only the ones
that differ from some other environment:

```yaml
# deploy/overlays/staging/kustomization.yaml
resources: ["../../base"]
configMapGenerator:
  - name: orders-api
    behavior: merge
    literals:
      - LOG_LEVEL=debug
      - HTTP_CORS_ORIGIN=https://staging.app.example.com
      - HTTP_JWT_ISSUER=https://id.staging.example.com/
      - HTTP_JWT_AUDIENCE=orders-api
      - HTTP_JWT_JWKS_URI=https://id.staging.example.com/.well-known/jwks.json
      - HTTP_OIDC_ISSUER=https://id.staging.example.com/
      - HTTP_OIDC_CLIENT_ID=orders-staging
      - HTTP_OIDC_REDIRECT_URI=https://staging.app.example.com/auth/callback
```

The difference between two environments is then a file somebody reviews,
rather than a selector the process reads and a set of defaults it carries for
every environment it might be told it is in. **And a forgotten required
variable fails closed**, because the base does not carry it: an overlay that
leaves out `HTTP_JWT_ISSUER` produces a pod whose environment has none, which
is a `ConfigInvalid` naming it, exit `78`, before the pod ever turns ready. A
variable with a default is the exception by construction — left out, it takes
the default — which is why `HTTP_CORS_ORIGIN` unset means CORS off: cross-origin
browsers are refused rather than admitted from the wrong origin.

Locally the same role is played by `node --env-file`, which `pnpm dev` already
uses: a file read **by the runtime, before** the process starts, so the
framework still sees only an environment — and a variable the shell already
set wins over the file.

## 4. Change a value: roll the pods

A running container's environment never changes, and the framework would not
re-read it if it did. **Refreshing configuration is a restart**:

```sh
kubectl rollout restart deployment/orders-api
```

or, so that editing the ConfigMap is itself what rolls the Deployment, let the
generator name it by its content — kustomize's `configMapGenerator` appends a
hash to the name and rewrites the reference, so a changed value is a changed
pod template.

**Why a restart rather than a reload.** A live-reloaded configuration is a
consistency problem the framework would have to solve at every reader: a pool
sized under the old value serving requests under the new timeout, a unit that
read half of each, a validation that passed at boot and is never run again.
A restart has none of that, and it is cheap here — each old pod
[drains in three beats](/explanation/draining-in-three-beats), so in-flight
work finishes and the ingress stops routing before the process goes. And a bad
bad value — a required one missing, or any one malformed — fails **the new
pod's** boot with exit `78`. Whether the old pods keep serving meanwhile is the rollout
strategy's: under `RollingUpdate` with `maxUnavailable: 0` the rollout stops
with every old pod still serving, while `Recreate` has already terminated them.

Rotating `HTTP_SESSION_KEYS` is two rollouts for the same reason the variable
is a list: put the new key **first** (it seals) and keep the old one after it
(it still unseals cookies already issued), roll; once the longest session the
old key sealed has expired (`ttlSec`, twelve hours by default), drop it and
roll again.

## See also

- [Configure from the environment](/how-to/configure-from-the-environment) —
  every variable the starters read, and binding your own.
- [Containerize and deploy](/how-to/containerize-and-deploy) — the image and
  the Deployment these fragments slot into.
- [Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes) — the
  knobs the restart relies on.
