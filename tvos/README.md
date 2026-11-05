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
from a Mac on the same network. `AO_LINK` is saved on the TV; without it the app asks for a link. A free (personal) team's install
expires after 7 days.

Remote (Siri Remote clickpad):

| input | overview | following an agent |
| --- | --- | --- |
| circle the outer ring | spin 360° around the room | spin around the agent |
| swipe up / down | zoom | zoom |
| swipe left / right | pan across the room | spin around the agent |
| click ◀ ▶ | follow previous / next agent | previous / next agent |
| click select | follow the first agent | stop following |
| click ▲ | home view | home view |
| click ▼ | room chat on / off | room chat on / off |
| play/pause | agent list on / off (▲▼ move through it, select follows that agent and opens its chat) | this agent's chat on / off |
| hold play/pause | hide all UI | hide all UI |
| back | agent chat → room chat → closed, then "press back again to exit" | same, then stop following |
| hold select | forget the office link | forget the office link |

A circle and a swipe are told apart by how much the finger's heading turns. The horizon never tilts. Holds fire
while the button is still down. A controls strip shows for a while after launch and after ▲. After 2 minutes without input the camera tours: it spins slowly and visits whoever just
spoke or started working, 20 s each; any input ends the tour.

Testing headless in the simulator: `AO_PRESSES="playPause+right+down+menu"` replays presses (one per `AO_PRESS_GAP`
seconds, from 8 s after launch), `AO_TOUR_AFTER=6` starts the tour sooner and `AO_STATS=1` shows SceneKit statistics and logs tick timings, via `SIMCTL_CHILD_…` (or `devicectl … --environment-variables` on the TV). Separate presses
with `+`: a comma in the value breaks `simctl launch`. With `--terminate-running-process` every other launch can land
on the home screen; launch again.

## Icon

`icon/make-svg.py` draws the icon as SVG layers (`back.svg` sky, `front.svg` an isometric voxel office) and
`swift icon/render.swift icon AgentOfficeTV/Resources/Assets.xcassets` renders them into the tvOS brand assets
(layered app icon 400×240 @1x/@2x and 1280×768, top shelf 1920×720 and 2320×720).
