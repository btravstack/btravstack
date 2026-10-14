---
"@btravstack/temporal-worker": minor
"@btravstack/temporal-client": minor
---

Install a Temporal `DataConverter` (payload codecs) on both starters. `TemporalModule` takes `dataConverter`, an application-declared port whose `DataConverter` is handed to `Worker.create`; `temporalClient` takes the same port as an optional fourth argument and hands it to `new Client`. One provider, injected where the codec's key store lives, keeps the worker and its clients on one converter.
