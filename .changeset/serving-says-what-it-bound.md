---
"@btravstack/core": minor
"@btravstack/observability": patch
---

Say what the runtime bound. The `serving` event now carries `info` and
`probePort`.

The kernel knew every bound port and never said one out loud. `probePort()` and
`runtimeInfo()` resolved them, both were tested, and neither had a single
production consumer — an application booted, said `serving`, and did not say
what it was serving on. So `PORT=0` and `PROBE_PORT=0` were supported and
unusable: the ephemeral bind is deliberate, but a human running the process had
no way to learn which port they got, and the feature was reachable only from a
test holding the `RunningApp`.

```ts
| { readonly type: "serving"
    readonly runtime: string
    readonly info: unknown
    readonly probePort: number | undefined }
```

Additive, so an exhaustive `EventSink` keeps compiling. `info` is `unknown`
because the kernel does not know a runtime's `Info` at the event union —
`RuntimeInfoOf<X>` is read off the module at `start`'s call site — and a sink
is serialising it anyway; a generic `KernelEvent<Info>` would infect
`EventSink`, `stderrSink` and every adapter for one field none of them reads
structurally. `probePort` is its own field rather than part of `info`, because
the probe server is the **kernel's** listener and publishing it as something
the runtime said would be a small lie.

`@btravstack/observability`'s `kernelEvents` spreads `info` into the line's
attributes when it is a plain record, so the three runtimes get `port`,
`taskQueue` + `namespace` and `queues` on their `serving` line with no
per-runtime logging code — the point of putting it on the event. The record
guard is also what keeps a hand-rolled runtime publishing a string from
costing the line.

`examples/` drops its hardcoded dev ports for `0`. Pinning `3000` and
`9000`/`9001`/`9002` was the workaround for this gap, and it broke on parallel
worktrees — two checkouts running `pnpm dev` collided on all four ports.

Not included, and declined for the record: auto-increment on a busy port. The
probe port is a contract with the kubelet, so quietly binding `9001` when
`9000` is taken means the probe hits nothing and the pod flaps. An occupied
`PROBE_PORT` is a real misconfiguration and `RuntimeStartFailed` naming
`"probes"` stays the right answer.
