---
"@btravstack/http": minor
---

`HttpController` is minted from a contract key — `api.HttpController(contract, "orders")` — and `HttpRouter(contract)` composes an array of pieces, `api.HttpRouter(contract)([ordersController, customersController])`. The keyed-record composing form is retired: every starter now mints a piece from its contract key and composes an array, so the three transports share one authoring flow. The key rides the piece's port id, so a fragment claimed by two slices is di's duplicate-provider defect at build, and a fragment no piece covers is refused at the composing call.
