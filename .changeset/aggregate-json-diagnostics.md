---
"@btravstack/observability": patch
---

Keep bounded aggregate error constituents and tagged identities in JSON diagnostics, without copying arbitrary secret-bearing payload fields. Redact nested non-error objects, functions and BigInt reasons, and omit malformed or accessor-valued aggregate member lists without losing the diagnostic. Read indexed members through own data descriptors so an accessor cannot drop valid siblings.
