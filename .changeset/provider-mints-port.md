---
"@btravstack/di": minor
---

`Provider("Id")({ inject, ...options })` mints the port it provides from what the arm builds and hands it back as `.port`, so a use case with one implementation no longer restates its shape in a separately declared port. `Provider` gains an optional fourth type parameter, the type of its `port` field.
