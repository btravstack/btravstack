# start logo — the chequered-flag beet

**Date:** 2026-08-12
**Status:** approved (concept, pose, and colors picked interactively on a rendered candidate page)

## Concept

Every BtravStack project mark is the chibi beet caught mid-scene, with a prop.
For `start`, the scene is **the wave**: the beet thrusts one arm high and waves
a **real chequered racing flag** — black-and-white checks — with pale-green
wind strokes trailing the cloth. "Green means go" stays in the mark through the
wind strokes and the package accent; the cloth itself is the authentic racing
flag.

Explored and rejected on the way here: the July "liftoff beet" (rocket) concept,
a power-button (⏻) scene, a knife-switch scene, a plain green flag (became the
chequered flag), and green-and-white checks (the user chose authentic
black-and-white).

## Scene specification

Wave pose, validated at 108/32/16 px on both canvases:

- **Beet:** the standard house grammar, geometry lifted from the existing marks
  (unthrown's beet paths): body `#CE3D80`, right-side shade `#8E1A52` at 0.85,
  leaf tufts `#2C8B4E` / `#3DAE62`, dot eyes `#3A0D24` with white glints, blush
  circles `#EE9CC4` at 0.75, root-tail stroke `#8E1A52`. Face: open cheering
  smile (`M44,71 Q50.5,79 57,71` stroke `#3A0D24`).
- **Pose:** left arm angled down (rounded rect, `rotate(30 20 62)`), right arm
  raised (`rotate(-52 80 62)`), a `#CE3D80` hand circle gripping the pole.
  Beet group at `translate(12,52) scale(0.75)` in a `viewBox="0 0 156 160"`.
- **Pole:** `M80,88 L93,12`, stroke width 4, round caps. Neutral grey that
  inverts per canvas (dark canvas `#8A94A3`, light canvas `#5A6675`) — the
  di needle-shaft rule.
- **Flag:** cloth path `M0,0 C14,-6 30,7 52,-3 L48,18 C27,26 13,13 -2,19 Z`
  placed at `translate(92,16) rotate(4)`, filled with a chequered pattern
  (`patternUnits="userSpaceOnUse"`, 15×15 tile, two 7.5 squares,
  `patternTransform="rotate(-7)"`), clipped to the cloth. A fold shade
  (`#000` at 0.18) darkens the fly-end curl.
  Check values invert per canvas: **dark** `#EDE9F0` + `#3A3540`, **light**
  `#F4F2F7` + `#221F26`.
- **Wind strokes:** three short strokes left of the flag (`#7ED09A`, width 4,
  round caps, 0.8 opacity) — the accent's presence in the mark.
- The flag flies well above and to the right of the leaves so it never reads
  as a third leaf at favicon size (verified at 16 px).

## Package accent

`--pkg-start: #2FAE4E` (true green, hue 135°):

- vs dark card `#100F12`: **6.63** — inside the family's 5.00–7.25 band.
- 30%-darkened (`#217A37`) vs white: **5.38** — clears 4.5.
- Hue distance from unthrown's teal `#3FB0A5` (172°) and di's blue `#3E7FD4`
  (215°) keeps the cool colors distinguishable.

Cite both numbers wherever the token ships (the `--pkg-entity` / `--pkg-di`
changeset pattern).

## Deliverables (this effort)

Following di's exact asset pattern, in this repo:

- `docs/public/logo.svg` — dark-canvas master (byte-identical to
  `logo-dark.svg`), doubles as favicon when the docs site exists.
- `docs/public/logo-dark.svg`, `docs/public/logo-light.svg` — only
  canvas-dependent values differ (pole grey, check values).
- README header `<img src="docs/public/logo.svg" …>` centered above the title,
  as di's README does.
- Each SVG opens with a comment block recording the concept, house practice.

Out of scope (separate, later efforts): landing integration
(`apps/website/public/logos/start-{light,dark}.svg`, the `--pkg-start` token,
a landing panel), the og image, and the docs site itself.

## Verification

- Headless-render both variants on their canvases at 108/32/16 px; the flag
  must read as a flag (not a leaf) at 16 px.
- The two contrast numbers above are recomputed and cited in the commit.
