# One HTTP application

Node `>=22.12.0`. This directory is a standalone project, not a monorepo
workspace. It uses published packages, one validated HTTP contract, one
composition root and one entry point.

```sh
npm install --strict-peer-deps
npm run typecheck
npm run build
PORT=3000 npm start
```

Call `POST /rpc/hello` with the oRPC JSON envelope:

```sh
curl -s http://localhost:3000/rpc/hello \
  -H 'content-type: application/json' \
  -d '{"json":{"name":"world"}}'
```

It answers `{"json":{"message":"Hello, world!"}}`. Send SIGTERM to the Node
process listening on the port to watch it drain and exit cleanly:

```sh
kill -TERM $(lsof -ti tcp:3000 -sTCP:LISTEN)
```

## Coordinated upgrades

All `@btravstack/*` dependencies use the same exact published release. Upgrade
them together. All five `@orpc/*` packages use one exact beta: the `latest`
dist-tag still selects the older major, and mixing beta releases can break
peers. Keep `@unthrown/orpc` on the minor admitted by `orpc-server`'s published
peer range. Check those ranges before updating the beta and unthrown packages,
then repeat typecheck, build, an endpoint call and SIGTERM. Commit the lockfile
your first install creates.

## Add a second slice

Add the second capability's contract under a new key in `src/contract.ts`,
then implement that key beside `hello` in `src/app.ts`. The router's type
requires every contract procedure to have an implementation. Once either
capability needs its own services, split the pieces into ordinary slice
modules using [Add a slice](https://btravstack.github.io/btravstack/how-to/add-a-slice).
No generator or workspace tool is required.
