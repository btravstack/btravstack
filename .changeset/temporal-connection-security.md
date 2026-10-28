---
"@btravstack/temporal-worker": minor
"@btravstack/temporal-client": minor
---

Secure the Temporal connection with TLS, mTLS or an API key, configured from Temporal's own environment variables (`TEMPORAL_TLS`, `TEMPORAL_TLS_SERVER_CA_CERT_PATH`, `TEMPORAL_TLS_SERVER_NAME`, `TEMPORAL_TLS_CLIENT_CERT_PATH`, `TEMPORAL_TLS_CLIENT_KEY_PATH`, `TEMPORAL_API_KEY`) plus `TEMPORAL_API_KEY_PATH` and `TEMPORAL_CREDENTIALS_RELOAD_MS`. Mounted certificate and key files are read again on that interval: a renewed certificate moves the worker or client to a new connection, a renewed API key is set on the open one, without a restart. A combination it cannot connect with is a `ConfigInvalid` at startup. `@btravstack/temporal-client` now peer-depends on `@btravstack/config` and exports `temporalSecurity`.
