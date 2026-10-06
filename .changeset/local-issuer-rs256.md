---
"@btravstack/testing": minor
---

**Removed: `localIssuer`'s `algorithm` option.** Nothing passed it. The issuer always signs with RS256, which was already the default, so a call without the option behaves exactly as before.
