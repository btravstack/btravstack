---
"@btravstack/temporal-testing": patch
---

`temporalServer` now waits for a concurrent run's container for up to `startupTimeoutMs`, with a backoff from 100 ms to 1 s, instead of ten attempts 100 ms apart. On a loaded Docker host, such as a CI Docker-in-Docker that has just pulled the image, Docker can list the winner's container more than a second after it reserves the name, and the refused run failed its global setup with Docker's `409`.
