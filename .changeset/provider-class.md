---
"@btravstack/di": minor
---

`Provider.class(id, { inject })` mints the base of a use case written as a class: the subclass is its own port, provider and service type, with its services typed on a protected `this.deps`. It replaces `Provider("Id")`, which is removed, along with `Provider`'s fourth type parameter. Every port slot now accepts a constructor of any arity.
