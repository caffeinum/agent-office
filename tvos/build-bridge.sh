#!/bin/sh
# Bundles the web viewer's pure modules (furniture, model, catalog) into the JavaScriptCore bridge the app loads.
set -e
cd "$(dirname "$0")/.."
node_modules/.bin/esbuild tvos/bridge/entry.js --bundle --format=iife --target=es2020 \
  --alias:three=./tvos/bridge/three-stub.js --log-override:import-is-undefined=silent \
  --outfile=tvos/AgentOfficeTV/Resources/office-bridge.js
