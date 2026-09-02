---
"@btravstack/http-server": patch
"@btravstack/temporal-worker": patch
"@btravstack/amqp-worker": patch
---

An array gate names the missing key at every arity, and stands down when a
piece's mint was already refused.

The refusal was a fixed two-element tuple `[marker, missingKey]`, so TypeScript
lined an array up against it — and named the key — only when the array happened
to be two elements long. At one or three, the diagnostic carried the marker
alone and the developer diffed the contract against the array by hand. It is now
a tuple **as long as the array the caller wrote**: its head the caller's own
elements, which match, and its last element the marker paired with what is
missing. Measured on a one-element array:

```text
… is not assignable to type 'readonly ["UNCOVERED HANDLERS — the contract declares a consumer this array does not cover", "right"]'.
```

`UNCOVERED CONTROLLERS`, `UNCOVERED HANDLERS`, `UNCOVERED ACTIVITIES`,
`OVERLAPPING CONTROLLERS` and `UNSLICEABLE CONTRACT KEY` all take the shape.

**`@btravstack/http-server` gains a second fix.** A typo'd mint —
`OrpcController(contract, "billing")` on a contract with no `billing` — is a
`TS2345` listing every valid path, and the value TypeScript hands back is typed
from the parameter it rejected, so its key reads as _all_ of them at once. That
union contains `"v1"` and `"v1.orders"`, which is exactly what `Overlapping`
refuses, and the router call then reported `OVERLAPPING CONTROLLERS` where
nothing overlapped: first error right, loudest error wrong. Both array gates now
stand down when an element's key is a union — the program does not compile
either way, and the mint's own error is the one to read.

New page: [Read a wiring error](https://btravstack.github.io/btravstack/how-to/read-a-wiring-error)
— where the actionable sentence is, why the line is wide, what each marker
means, and the two `TS4023` lines an application can turn off.

Closes #204.
