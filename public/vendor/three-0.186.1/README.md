three.js r186 (`three@0.186.1`, MIT), vendored verbatim from the npm tarball — no package.json dependency,
no bundler. `three.module.js` + `three.core.js` + `LICENSE` from `build/`; `addons/` mirrors
`examples/jsm/` for the files the viewer uses (OrbitControls, EffectComposer/RenderPass/UnrealBloomPass/
OutputPass and their helper passes/shaders). Addons import the bare specifier `three`, resolved by the
importmap in office.html.

Refresh: `npm pack three@<version>` (respect the 7-day release-age gate) → copy the same files, rename
the folder, update the importmap.
