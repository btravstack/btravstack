# `@btravstack/start-core` example: the shared configuration reader

Three deployments, one way to read an environment variable — and the seven cases
it has to survive pinned once instead of three times.

```
src/env.ts       wholeNumber / port, and the issue formatter
src/env.spec.ts  the seven cases, against the fragments themselves
```

## Why a package rather than a copy in each deployment

`order-api`, `order-worker` and `order-temporal` each validate `process.env`
through a schema and return it as a `Result`. That much is the point, and each
keeps its own schema: its variables, its defaults, its bounds. What they were
also each keeping was the _fragment_ —

```ts
export const wholeNumber = (fallback: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .pipe(z.coerce.number<string>().int().min(min).max(max))
    .default(fallback);
```

— and a copy of the reasoning that makes it correct, and a copy of the seven
tests that prove it. Three copies of a subtle thing is three chances to fix it
in one place only.

## The subtle thing

The non-empty string in front of the coercion is load-bearing. Coercion is
`Number()` underneath, so `PORT=` is `0` — and the bounds cannot catch that,
because a port's `min` **is** `0`: an ephemeral bind has to stay expressible.
An empty value is a configuration **error**, not an absent one, and
`.default(...)` applies only when the variable is genuinely missing.

With that guard in place the bounds do the rest: `abc` is `NaN`, `3.5` is not an
integer, `99999` is out of range.

## What each deployment still owns

Its variables, their defaults, and whatever is genuinely its own — so
`order-worker`'s spec pins that `CONCURRENCY=0` is rejected where a port's own
bounds would allow it, and `order-temporal`'s pins that a blank
`TEMPORAL_NAMESPACE` is an error rather than a default. Those are facts about a
deployment, not about the fragment.

`describeEnvIssues` is here too: every entry point folds a bad environment into
the same one-line-per-issue message and a non-zero exit code.
