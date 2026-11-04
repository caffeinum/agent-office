# Agent Office for Apple TV

A native tvOS viewer (tvOS has no browser or web view). Read-only, live over the office viewer WebSocket.

- `bridge/entry.js` bundles the web viewer's own pure modules (furniture models, desk seating, idle spots, wander slots,
  `office_status at`) for JavaScriptCore, so the TV puts every agent exactly where a browser does.
- `AgentOfficeTV/Sources` draws it with SceneKit: `Bridge` (JSContext), `Connection` (WebSocket with the key in a
  subprotocol), `OfficeRenderer` (room, furniture), `AgentNode` (characters, name tags).

## Build and run

```sh
brew install xcodegen
tvos/build-bridge.sh                      # after changing bridge/entry.js or the web modules it imports
cd tvos && xcodegen generate
xcodebuild -project AgentOfficeTV.xcodeproj -scheme AgentOfficeTV -destination 'id=<apple tv udid>' -allowProvisioningUpdates build
xcrun devicectl device install app --device <udid> <derived data>/Build/Products/Debug-appletvos/AgentOfficeTV.app
xcrun devicectl device process launch --device <udid> --environment-variables '{"AO_LINK":"https://<host>/o/<office>#k=<key>"}' com.bykhun.agentoffice.tv
```

Pair the Apple TV first (TV: Settings → Remotes and Devices → Remote App and Devices; Xcode → Devices and Simulators),
from a Mac on the same network. `AO_LINK` is saved on the TV; without it the app asks for a link. Remote: left/right
turns the camera, play/pause forgets the link. A free (personal) team's install expires after 7 days.
