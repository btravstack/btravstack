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

## 1. The plain variables: a ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: orders-api
data:
  PORT: "8080"
  HOST: "0.0.0.0"
  LOG_LEVEL: "info"
  PRE_DRAIN_DELAY_MS: "10000"
  DRAIN_TIMEOUT_MS: "40000"
  HTTP_CORS_ORIGIN: "https://app.example.com"
  HTTP_JWT_ISSUER: "https://id.example.com/"
  HTTP_JWT_AUDIENCE: "orders-api"
  HTTP_JWT_JWKS_URI: "https://id.example.com/.well-known/jwks.json"
```

Every value is a string, because an environment only carries strings — the
`Config` field on the other side is what turns `"10000"` into a number and
refuses `"10s"` by name.

## 2. The secret ones: a Secret, referenced by key

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: orders
type: Opaque
stringData:
  database-url: "postgres://orders_app:…@db.internal:5432/orders"
  session-keys: "…"
  oidc-client-secret: "…"
```

Both reach the container as plain environment variables, which is all the
framework can tell apart:

```yaml
containers:
  - name: api
    envFrom:
      - configMapRef: { name: orders-api }
    env:
      - name: DATABASE_URL
        valueFrom:
          secretKeyRef: { name: orders, key: database-url }
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
  base/               Deployment, Service, and a configMapGenerator for the
                      variables above, so every overlay merges into one map
  overlays/
    staging/          kustomization.yaml patching LOG_LEVEL, HTTP_CORS_ORIGIN
    production/       kustomization.yaml patching replicas, the drain knobs
```

```yaml
# deploy/overlays/staging/kustomization.yaml
resources: ["../../base"]
configMapGenerator:
  - name: orders-api
    behavior: merge
    literals:
      - LOG_LEVEL=debug
      - HTTP_CORS_ORIGIN=https://staging.app.example.com
```

The difference between two environments is then a file somebody reviews,
rather than a selector the process reads and a set of defaults it carries for
every environment it might be told it is in. A variable forgotten in one
overlay is not a wrong default: an unset required field is a `ConfigInvalid`
naming it, exit `78`, before the pod ever turns ready.

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
value fails **the new pod's** boot with exit `78`, so a rollout with
`maxUnavailable: 0` stops with the old pods still serving.

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
