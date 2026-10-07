---
"@btravstack/core": patch
---

**The stop deadline now covers a startup failure's cleanup, and the lifecycle stays in `stopping` until the finalisers finish.** A runtime that refused to start over a graph whose `release` never settled left `exited` pending forever; `stopTimeoutMs` now bounds that cleanup too, emitting `stoppedWaiting` while `exited` still reports the startup failure. And the signal handlers are no longer removed, nor the phase moved to `exited`, before di's finalisers have run, so a second signal during a blocked `release` takes the abandoned-stop path instead of reaching no handler.
