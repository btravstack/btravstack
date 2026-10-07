# Framework and entity identity

The framework keeps its approved illustrated mascot: a smiling beetroot atop
three teal layers. The light/dark SVGs use native vector paths and gradients
for the matching surface; the grayscale asset is for grayscale print.
`../public/logo.png` preserves the original approved raster illustration byte
for byte. The SVGs are a vector interpretation of that illustration, not a
pixel-identical replacement.

Canonical source: [generate-brand.mjs](https://github.com/btravstack/btravstack.github.io/blob/main/scripts/generate-brand.mjs), project `framework`.
The coordinated social card comes from [social-card.html](https://github.com/btravstack/btravstack.github.io/blob/main/branding/social-card.html?project=framework)
and is rendered at 1200 × 630. These are committed local copies; the docs do not
load logos from the ecosystem website at runtime.

The integrated entity guide uses the canonical `entity` identity-card SVGs.
Render `social-card.html?project=entity` at 1200 × 630 for its local preview;
the card displays `btravstack.github.io/btravstack/entity`.

DI reference and API pages use the canonical leafless beetroot in a syringe.
Render `social-card.html?project=di` at 1200 × 630 for `../public/di/og-di.png`.
All three cards use the shared large-mascot layout and short headlines; wait
for fonts and images before exporting, and review at thumbnail size.
