---
"@btravstack/http-server": minor
---

The session codec seals login state under its own marker

`SessionCodecService` carries a `transient` pair beside `seal`/`unseal`:
`codec.transient.seal(state)` takes the login flow's own record of strings — a
PKCE verifier, `state`, `nonce`, where to return to — and seals it with the SAME
keys under `typ: "oidc"` and a fixed lifetime of `TRANSIENT_TTL_SEC`, five
minutes; `codec.transient.unseal(cookie)` requires that marker back and answers
the state with the codec's own stamps stripped, or nothing.

The session reader keeps requiring `typ: "session"`, so the two purposes refuse
each other in both directions: a transient replayed under the session cookie's
name is anonymous, and a session presented as login state is nothing. Five
minutes is a constant rather than an option — a login that takes longer is a
login to start again — and the pair lives on the codec rather than a second
provider because the decoded keys live inside the codec.
