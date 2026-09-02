---
"@btravstack/config": minor
---

A pinned value is checked by its field's own rule, closing the one input to the
configuration system that was never validated.

`Config.pinned(value, field)` answered `Ok(value)` unconditionally, so the
composition-root route bypassed every bound the environment route enforces. The
case that mattered was silent: `Config.pinned(Number.NaN, bodyLimit)` disabled a
trust boundary outright, because `size > NaN` is `false` and nothing ever
reported it. A `default` had the same hole — `present` returned `Ok(default)`
without running the field's rule.

`ConfigField` now carries an optional `check` — the field's rule over a value
that is already a `T` — which `pinned` and `default` both run. `integer` and
`port` carry one; a field without one (`string`, or any hand-written field)
accepts whatever it is pinned. The diagnostic is
identical whichever route the bad value came from:

```text
HttpConfig could not be configured:
  HTTP_BODY_LIMIT: must be between 0 and 9007199254740991, got -1
```

`check` is optional, so a hand-written `ConfigField` (the shape the reference
page shows) keeps compiling and accepts whatever it is handed. `Config.object`
now collects `AnyConfigField`, whose `check` takes `never`: a function is
contravariant in its parameter, and without that a `Record<string,
ConfigField<unknown>>` constraint would no longer admit a `ConfigField<number>`.

`Config.pinned(0, Config.port(…))` still binds the ephemeral port — the floor is
`0`, not `1`.

**`Config.string` deliberately has no `check`**, against the issue's own
proposal: "set but empty" is a rule about the RAW value — a deployment mistake —
where a pinned `""` is a decision, and this repository already pins exactly that
(`http({ cors: false })` pins the empty origin, which means "off"). Checking it
would refuse a switch for looking like a blank variable.

One behaviour change falls out for consumers: a pinned port outside `0..65535`
is now `ConfigInvalid` at graph build (exit 78) rather than a `listen` failure
surfaced later as `RuntimeStartFailed` (exit 1). That is the more precise code
for what went wrong, and the failure now names the option rather than the
socket.

Closes #177.
