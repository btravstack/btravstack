---
"@btravstack/amqp": patch
"@btravstack/temporal": patch
---

Compose a worker's handlers and activities from one provider per contract key.

`AmqpHandler(contract, key)` and `TemporalWorkflowActivities(contract, key)` each
mint a port from the contract key and return di's own `Provider(port)`, so a slice
owns its piece and declares only the services that piece calls.
`AmqpHandlers(contract)([…])` and `TemporalActivities(contract)([…])` compose them:
every declared key must be covered, and two slices claiming one key are di's
duplicate-provider defect at build. Both starters' existing call forms are unchanged.
