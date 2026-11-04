#!/bin/sh
# Build, install and launch on the tvOS simulator, then screenshot it: tvos/sim.sh <office link> [out.png]
set -e
cd "$(dirname "$0")"
SIM=$(cat /tmp/aotv-sim)
./build-bridge.sh >/dev/null
xcodegen generate >/dev/null
xcodebuild -project AgentOfficeTV.xcodeproj -scheme AgentOfficeTV -sdk appletvsimulator -destination "id=$SIM" -derivedDataPath /tmp/aotv-sim-dd build CODE_SIGNING_ALLOWED=NO 2>&1 | grep -E "error:|BUILD" || true
xcrun simctl install "$SIM" /tmp/aotv-sim-dd/Build/Products/Debug-appletvsimulator/AgentOfficeTV.app
SIMCTL_CHILD_AO_LINK="$1" xcrun simctl launch --terminate-running-process "$SIM" com.bykhun.agentoffice.tv >/dev/null
sleep "${WAIT:-10}"
xcrun simctl io "$SIM" screenshot "${2:-/tmp/aotv-sim.png}" >/dev/null 2>&1
echo "${2:-/tmp/aotv-sim.png}"
