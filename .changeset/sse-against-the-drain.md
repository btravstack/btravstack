---
"@btravstack/http-server": minor
---

Server-sent events are supported through the HTTP starter. An open
`text/event-stream` response is reset when the drain begins, at beat 3's
start, so the client reconnects to a replica that is staying and the unit is
counted `completed` rather than `abandoned`. `GET` is admitted on a procedure
whose output is an event iterator, which is the one request a browser's
`EventSource` can send.
