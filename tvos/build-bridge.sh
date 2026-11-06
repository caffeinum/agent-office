#!/bin/sh
# Bundles the web viewer's pure modules (furniture, model, catalog) into the JavaScriptCore bridge the app loads
# (built into the app as a fallback, and served at /tv/office-bridge.js for the app to download).
set -e
cd "$(dirname "$0")/.."
node_modules/.bin/esbuild tvos/bridge/entry.js --bundle --format=iife --target=es2020 \
  --alias:three=./tvos/bridge/three-stub.js --log-override:import-is-undefined=silent \
  --outfile=tvos/AgentOfficeTV/Resources/office-bridge.js
# the same bundle on the office's site: the app downloads it, so behaviour changes reach the TV without a rebuild
mkdir -p public/tv
cp tvos/AgentOfficeTV/Resources/office-bridge.js public/tv/office-bridge.js
