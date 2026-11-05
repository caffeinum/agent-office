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
| move a finger left / right | turn around the room, by how far the finger moved | turn around the agent |
| move a finger up / down | zoom | zoom |
| double tap, keep the finger down and move | move the camera over the floor the way the finger goes, up = forward (no turn or zoom) | stop following and slide from there |
| click ◀ ▶ | follow previous / next agent | previous / next agent |
| click select | follow the first agent | stop following |
| click ▲ | home view (also undoes a slide) | home view |
| click ▼ | room chat on / off | room chat on / off |
| play/pause | agent list on / off (▲▼ move through it, select follows that agent and opens its chat) | this agent's chat on / off |
| hold play/pause | hide all UI (names too; only speech bubbles stay) | same |
| hold ▲ | radio: off → SomaFM Fluid → Groove Salad → 0R Lo-Fi → off (remembered) | same |
| back | agent chat → room chat → closed, then "press back again to exit" | same, then stop following |
| hold select | forget the office link | forget the office link |

Touch is relative and two-axis at once: only finger movement counts, never where it lands; the pad's centre dead
zone (which reads as (0, 0), like a lift) is debounced, and the camera eases toward its goal. The horizon never tilts. Holds fire
while the button is still down. A controls strip shows for a while after launch and after ▲. After 2 minutes without input the camera tours: it spins slowly and visits whoever just
spoke or started working, 20 s each; any input ends the tour.

Testing headless in the simulator: `AO_PRESSES="playPause+right+down+menu"` replays presses (one per `AO_PRESS_GAP`
seconds, from 8 s after launch), `AO_TOUR_AFTER=6` starts the tour sooner and `AO_STATS=1` shows SceneKit statistics and logs tick timings, `AO_SOUND=0` mutes the foley (on by default; `AO_VOLUME` sets the master, 0.32), `AO_TIME=night|day` overrides the local clock (night 19:00–07:00, like the web), `AO_SHADOW_SAMPLES`/`AO_SHADOW_MAP` tune the sun shadow (default 4 samples, 2048 map: 8 and 4096 halved the frame rate up close), AO_STATS also logs frames drawn per second, via `SIMCTL_CHILD_…` (or `devicectl … --environment-variables` on the TV). Separate presses
with `+`: a comma in the value breaks `simctl launch`. With `--terminate-running-process` every other launch can land
on the home screen; launch again.

## Icon

`icon/make-svg.py` draws the icon as SVG layers (`back.svg` sky, `front.svg` an isometric voxel office) and
`swift icon/render.swift icon AgentOfficeTV/Resources/Assets.xcassets` renders them into the tvOS brand assets
(layered app icon 400×240 @1x/@2x and 1280×768, top shelf 1920×720 and 2320×720).
