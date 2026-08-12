# Vendored Meshtastic browser runtime

MESHBOARD v0.6.8 vendors the browser-executable Meshtastic runtime required for USB/Web Serial operation. CONNECT RADIO therefore does not depend on a CDN, runtime ESM transformer, Node compatibility shim, or bare npm package specifier.

## Upstream provenance

- Project: `meshtastic/web`
- Release tag: `v2.7.2` (release display name `v2.7.5`)
- Commit: `ee5243a2059126ecd799927d21e052b5f5745974`
- Official GitHub Actions workflow: `Release Web`
- Official workflow artifact: `web-build`, artifact ID `9030778804`
- Upstream license: GPL-3.0-only

## Vendored files

- `vendor/meshtastic-runtime.js` — browser-only extraction from the official production bundle through the Web Serial transport declaration. MESHBOARD v0.6.8 uses the compatibility `MeshDevice`/SDK runtime from this file but no longer instantiates the upstream Web Serial transport; MESHBOARD owns that lifecycle locally so it can release browser stream locks deterministically.
- `vendor/dist-xiYX3mxm.js` — lazy companion chunk referenced by the same official production bundle.
