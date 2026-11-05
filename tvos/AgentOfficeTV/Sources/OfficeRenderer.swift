import GameController
import SceneKit
import SpriteKit
import UIKit

/// Draws an OfficeScene with SceneKit, matching the web viewer: same furniture boxes, same characters and poses, the
/// web's A* walks, its 3/4 home camera, and DOM-style name pills kept at a constant screen size.
final class OfficeRenderer: NSObject {
    let scene = SCNScene()
    let camera = SCNNode()
    weak var bridge: Bridge? { didSet { voxel = bridge.map(Voxel.init) } }
    private var voxel: Voxel?
    private var walls: [(name: String, full: SCNNode, stub: SCNNode)] = []
    private(set) var view: OfficeSCNView?
    private let room = SCNNode()
    private let furniture = SCNNode()
    private let people = SCNNode()
    private let overlay = SKScene()
    private var sun: SCNNode!
    private var pills: [String: Pill] = [:]
    private var last: OfficeScene?
    private var agents: [String: AgentNode] = [:]
    private var link: CADisplayLink?
    private var lastTick: CFTimeInterval = 0
    private var clock: Double = 0

    // camera: the web's homeView() angles (azimuth π/4.6, polar 0.93 rad, 30° vertical fov), orbited by the remote's wheel
    // The horizon never tilts: the polar angle stays at the web's home view; only spin and zoom move the camera.
    private static let homeAzimuth: Float = .pi / 4.6
    private let polar: Float = 0.93
    private var azimuth: Float = OfficeRenderer.homeAzimuth
    private var zoom: Float = 1
    // input moves the goals; the camera eases toward them, so a jittery finger doesn't shake the picture
    private var azimuthGoal: Float = OfficeRenderer.homeAzimuth
    private var zoomGoal: Float = 1
    private var liftWork: DispatchWorkItem?
    private var camTarget = SCNVector3Zero
    private var camDist: Float = 30
    private(set) var follow: String? { didSet { if follow != oldValue { onFollow?(follow); refreshPills() } } }
    var onFollow: ((String?) -> Void)?
    private var touch: SIMD2<Float>?

    // Auto-tour: after `tourAfter` seconds without input the camera spins slowly and visits whoever just spoke or
    // started working, for `tourVisit` seconds each.
    private static let tourAfter = Double(ProcessInfo.processInfo.environment["AO_TOUR_AFTER"] ?? "120") ?? 120, tourVisit: Double = 20
    private var lastInput = CACurrentMediaTime()
    private var touring = false
    private var tourUntil: Double = 0
    private var lastSaid: [String: String] = [:], lastStatus: [String: String] = [:]

    override init() {
        super.init()
        scene.background.contents = UIColor(red: 0.78, green: 0.88, blue: 0.96, alpha: 1)
        for n in [room, furniture, people] { scene.rootNode.addChildNode(n) }
        camera.camera = SCNCamera()
        camera.camera?.fieldOfView = 30
        camera.camera?.projectionDirection = .vertical
        camera.camera?.zNear = 0.5
        camera.camera?.zFar = 400
        // the web renders through ACES tone mapping, which lifts and softens colours; approximate it on the camera
        camera.camera?.wantsHDR = true
        camera.camera?.wantsExposureAdaptation = false
        camera.camera?.exposureOffset = CGFloat(Double(ProcessInfo.processInfo.environment["AO_EXPOSURE"] ?? "0.35") ?? 0.35)
        camera.camera?.saturation = CGFloat(Double(ProcessInfo.processInfo.environment["AO_SATURATION"] ?? "0.8") ?? 0.8)
        camera.camera?.contrast = CGFloat(Double(ProcessInfo.processInfo.environment["AO_CONTRAST"] ?? "0") ?? 0)
        camera.camera?.bloomIntensity = 0
        scene.rootNode.addChildNode(camera)
        let sun = SCNNode()
        sun.light = SCNLight()
        sun.light?.type = .directional
        // scene.js day theme: sun #ffe4bd at 2.7 and hemisphere #d7ecff/#e3c39d at 1.25, each through three's
        // Lambert BRDF (÷π); SceneKit's lambert takes the light as is, so the intensities carry the ÷π
        sun.light?.intensity = 2.7 / .pi * 1000
        sun.light?.color = cssColor("#ffe4bd")
        sun.light?.castsShadow = true
        sun.light?.shadowMode = .forward
        sun.light?.shadowRadius = 3
        sun.light?.shadowSampleCount = 8
        sun.light?.shadowMapSize = CGSize(width: 4096, height: 4096)
        sun.light?.shadowBias = 0.05
        sun.light?.shadowColor = UIColor(white: 0, alpha: 1)
        sun.light?.automaticallyAdjustsShadowProjection = false
        scene.rootNode.addChildNode(sun)
        self.sun = sun
        let fill = SCNNode()
        fill.light = SCNLight()
        fill.light?.type = .ambient
        fill.light?.intensity = 1.25 / .pi * 1000 * 0.85
        fill.light?.color = cssColor("#ddd7ce")
        scene.fogColor = cssColor("#e8eef2")
        scene.fogStartDistance = 50
        scene.fogEndDistance = 160
        scene.rootNode.addChildNode(fill)
        overlay.scaleMode = .resizeFill
        overlay.backgroundColor = .clear
    }

    func attach(_ v: OfficeSCNView) {
        view = v
        v.scene = scene
        v.pointOfView = camera
        v.overlaySKScene = overlay
        link?.invalidate()
        link = CADisplayLink(target: self, selector: #selector(tick))
        link?.add(to: .main, forMode: .common)
        watchControllers()
    }

    func detach() {
        link?.invalidate()
        link = nil
    }

    func apply(_ s: OfficeScene) {
        let structural = last == nil || last!.grid != s.grid || last!.look != s.look || last!.wallH != s.wallH
        if structural { buildRoom(s) }
        if structural || last!.items != s.items || last!.kinds != s.kinds { buildFurniture(s) }
        syncAgents(s)
        if follow.map({ id in !s.agents.contains { $0.id == id } }) == true { follow = nil }
        if touring, let id = newsworthy(s) {
            follow = id
            tourUntil = CACurrentMediaTime() + Self.tourVisit
        }
        last = s
    }

    // MARK: room

    private func buildRoom(_ s: OfficeScene) {
        room.childNodes.forEach { $0.removeFromParentNode() }
        walls = []
        guard let bridge, let voxel else { preconditionFailure("renderer has no bridge") }
        do {
            try buildRoom(s, plan: bridge.room(s.grid), voxel: voxel)
        } catch {
            preconditionFailure("room build failed: \(error)")
        }
    }

    /// scene.js buildRoom(): textured floor, grass slab with a stone plinth, the seeded garden, four walls with cutaway stubs.
    private func buildRoom(_ s: OfficeScene, plan: RoomPlan, voxel: Voxel) throws {
        let w = Double(s.grid.w), d = Double(s.grid.d), look = s.look
        // a fixed shadow box over the room: the sun sits back along its own direction from the floor's centre
        // scene.js buildRoom: the sun sits along (-0.55, 1, 0.75) from the room's centre, R × 2.4 away
        let R = Float(hypot(w, d) / 2 + plan.border + 1)
        let c = SIMD3<Float>(Float(w / 2), 0, Float(d / 2))
        let at = c + simd_normalize(SIMD3<Float>(-0.55, 1, 0.75)) * R * 2.4
        sun.position = SCNVector3(at.x, at.y, at.z)
        sun.look(at: SCNVector3(c.x, c.y, c.z), up: SCNVector3(0, 1, 0), localFront: SCNVector3(0, 0, -1))
        sun.light?.orthographicScale = CGFloat(R)
        sun.light?.zNear = 0.5
        sun.light?.zFar = CGFloat(R * 5)
        scene.background.contents = try voxel.texture("sky")

        let floor = SCNNode(geometry: SCNPlane(width: w, height: d))
        floor.geometry?.firstMaterial = voxel.material(map: try voxel.texture("floor", look.floor.material), tint: cssColor(look.floor.color), repeat: CGSize(width: w, height: d))
        floor.eulerAngles.x = -.pi / 2
        floor.position = SCNVector3(w / 2, 0, d / 2)
        room.addChildNode(floor)

        let gw = w + plan.border * 2, gd = d + plan.border * 2
        let slab = SCNNode(geometry: SCNBox(width: gw, height: 1, length: gd, chamferRadius: 0))
        let plinth = try voxel.texture("plinth"), grass = try voxel.texture("grass")
        let alongX = voxel.material(map: plinth, repeat: CGSize(width: gw, height: 1)), alongZ = voxel.material(map: plinth, repeat: CGSize(width: gd, height: 1))
        // SCNBox faces: front (+z), right (+x), back (-z), left (-x), top, bottom
        slab.geometry?.materials = [alongX, alongZ, alongX, alongZ, voxel.material(map: grass, repeat: CGSize(width: gw, height: gd)), alongX]
        slab.position = SCNVector3(w / 2, -0.505, d / 2)
        room.addChildNode(slab)

        let grain = try voxel.texture("grain")
        let garden = SCNNode(geometry: try voxel.geometry(plan.garden))
        garden.geometry?.firstMaterial = voxel.material(map: grain)
        room.addChildNode(garden)

        let trim = voxel.material(map: grain, tint: cssColor(look.walls.trim))
        for wall in plan.walls {
            let accent = look.walls.accent.flatMap { $0.wall == wall.name ? $0 : nil }
            let body = voxel.material(map: try voxel.texture("wall", accent?.material ?? "plaster"), tint: cssColor(accent?.color ?? look.walls.color))
            let frame = SCNNode()
            frame.position = SCNVector3(wall.at[0], wall.at[1], wall.at[2])
            frame.eulerAngles.y = Float(wall.yaw)
            let full = SCNNode(), stub = SCNNode()
            for (parent, boxes, mat) in [(full, wall.body, body), (full, wall.trim, trim), (stub, wall.stubBody, body), (stub, wall.stubTrim, trim)] {
                let n = SCNNode(geometry: try voxel.geometry(boxes))
                n.geometry?.firstMaterial = mat
                parent.addChildNode(n)
            }
            stub.isHidden = true
            frame.addChildNode(full)
            frame.addChildNode(stub)
            room.addChildNode(frame)
            walls.append((wall.name, full, stub))
        }
        let posts = SCNNode(geometry: try voxel.geometry(plan.posts))
        posts.geometry?.firstMaterial = trim
        room.addChildNode(posts)
    }

    /// room.js cutaway(): walls the camera stands behind drop to their stubs.
    private func updateCutaway() {
        guard let g = last?.grid else { return }
        let p = camera.presentation.position
        let hide = ["back": p.z < 0.5, "front": p.z > Float(g.d) - 0.5, "left": p.x < 0.5, "right": p.x > Float(g.w) - 0.5]
        for w in walls {
            let h = hide[w.name] ?? false
            w.full.isHidden = h
            w.stub.isHidden = !h
        }
    }

    /// The agent that just said something or just started working (for the tour), recording what each one is doing now.
    private func newsworthy(_ s: OfficeScene) -> String? {
        var pick: String?
        for a in s.agents {
            if let say = a.says, lastSaid[a.id] != say { pick = a.id }
            else if a.status == "working", let was = lastStatus[a.id], was != "working", pick == nil { pick = a.id }
            lastSaid[a.id] = a.says
            lastStatus[a.id] = a.status
        }
        return pick
    }

    // MARK: furniture

    private func buildFurniture(_ s: OfficeScene) {
        furniture.childNodes.forEach { $0.removeFromParentNode() }
        guard let voxel else { preconditionFailure("renderer has no bridge") }
        var cache: [String: [(role: String, map: String?, geo: SCNGeometry)]] = [:]
        do {
            for item in s.items {
                guard let kind = s.kinds[item.kind] else { preconditionFailure("scene has item \(item.id) of unknown kind \(item.kind)") }
                if cache[item.kind] == nil {
                    cache[item.kind] = try kind.parts.map { p in
                        (p.role, p.map, try voxel.geometry(p.boxes, ao: p.role != "glow" && p.role != "glass"))
                    }
                }
                let node = try model(cache[item.kind]!, kind: kind, item: item, look: s.look, voxel: voxel)
                node.position = SCNVector3(item.x, 0, item.z)
                node.eulerAngles.y = Float(item.yaw)
                furniture.addChildNode(node)
            }
        } catch {
            preconditionFailure("furniture build failed: \(error)")
        }
    }

    /// One item: each part's shared mesh with the web's material for its role (scene.js builtinAssets/customAssets).
    private func model(_ parts: [(role: String, map: String?, geo: SCNGeometry)], kind: OfficeScene.Kind, item: OfficeScene.Item, look: OfficeScene.Look, voxel: Voxel) throws -> SCNNode {
        let node = SCNNode()
        let accent = cssColor(item.color ?? look.kindColors[item.kind] ?? kind.defaultColor ?? "#ffffff")
        let grain = try voxel.texture("grain")
        for p in parts {
            let mat: SCNMaterial = switch p.role {
            case "accent": voxel.material(map: try voxel.texture(p.map ?? "grain"), tint: accent)
            case "finish": voxel.material(map: grain, tint: cssColor(look.desk.wood))
            case "rail": voxel.material(map: grain, tint: cssColor(look.desk.rail))
            case "glow": voxel.glow(map: try p.map.map { try voxel.texture($0) }, tint: kind.glowColor.map(cssColor) ?? .white)
            case "glass": voxel.material(map: nil)
            default: voxel.material(map: grain)
            }
            if p.role == "glass" { mat.transparency = 0.38; mat.writesToDepthBuffer = false }
            let g = p.geo.copy() as! SCNGeometry
            g.firstMaterial = mat
            node.addChildNode(SCNNode(geometry: g))
        }
        return node
    }

    // MARK: agents

    private func syncAgents(_ s: OfficeScene) {
        let ids = Set(s.agents.map(\.id))
        for (id, n) in agents where !ids.contains(id) {
            n.node.runAction(.sequence([.scale(to: 0.01, duration: 0.42), .removeFromParentNode()]))
            agents[id] = nil
            pills[id]?.node.removeFromParent()
            pills[id] = nil
        }
        for a in s.agents {
            if let n = agents[a.id] {
                n.update(a) { [weak self] from, to in (try? self?.bridge?.route(from: from, to: to)) ?? [to] }
            } else {
                let n = AgentNode(a, voxel: voxel!)
                n.node.scale = SCNVector3(0.01, 0.01, 0.01)
                n.node.runAction(.scale(to: 1, duration: 0.42))
                people.addChildNode(n.node)
                agents[a.id] = n
            }
            let pill = pills[a.id] ?? Pill()
            if pills[a.id] == nil { overlay.addChild(pill.node); pills[a.id] = pill }
            pill.update(a, selected: follow == a.id)
        }
    }

    @objc private func tick(_ l: CADisplayLink) {
        let now = l.timestamp
        let dt = lastTick == 0 ? 0 : min(0.05, now - lastTick)
        lastTick = now
        clock += dt
        let t0 = CACurrentMediaTime()
        stepTour(now: now, dt: Float(dt))
        let list = Array(agents.values)
        for n in list { n.step(dt: Float(dt)) }
        let t1 = CACurrentMediaTime()
        if let angles = try? bridge?.limbs(list.map { ($0.pose, $0.agent.phase) }, t: clock), angles.count == list.count {
            for (n, a) in zip(list, angles) { n.apply(a, clock: clock) }
        }
        let t2 = CACurrentMediaTime()
        placeCamera(dt: Float(dt))
        updateCutaway()
        let t3 = CACurrentMediaTime()
        placePills()
        let t4 = CACurrentMediaTime()
        if Self.stats {
            perf.n += 1; perf.step += t1 - t0; perf.limbs += t2 - t1; perf.cam += t3 - t2; perf.pills += t4 - t3
            if now - perf.since > 2 {
                let ms = { (v: Double) in String(format: "%.1f", v / Double(self.perf.n) * 1000) }
                print("AO_STATS ticks/s \(Int(Double(perf.n) / (now - perf.since))) step \(ms(perf.step))ms limbs \(ms(perf.limbs))ms cam \(ms(perf.cam))ms pills \(ms(perf.pills))ms")
                perf = (now, 0, 0, 0, 0, 0)
            }
        }
    }

    private static let stats = ProcessInfo.processInfo.environment["AO_STATS"] != nil
    private var perf: (since: Double, n: Int, step: Double, limbs: Double, cam: Double, pills: Double) = (0, 0, 0, 0, 0, 0)

    // MARK: camera

    /// Home: the whole room (walls included) fits the screen, as homeView() frames it on the web. Following: close behind the agent.
    private func placeCamera(dt: Float) {
        guard let s = last, let v = view, v.bounds.height > 0 else { return }
        let aspect = Float(v.bounds.width / v.bounds.height)
        let ease = min(1, dt * 10)
        azimuth += (azimuthGoal - azimuth) * ease
        zoom += (zoomGoal - zoom) * ease
        var wantTarget: SCNVector3
        var wantDist: Float
        if let id = follow, let n = agents[id] {
            wantTarget = SCNVector3(n.node.position.x, 0.8, n.node.position.z)
            wantDist = 9 * zoom
        } else {
            wantTarget = SCNVector3(Float(s.grid.w) / 2, 0, Float(s.grid.d) / 2)
            wantDist = homeDistance(s.grid, aspect: aspect) * zoom
        }
        let k = min(1, dt * 4)
        camTarget = SCNVector3(camTarget.x + (wantTarget.x - camTarget.x) * k, camTarget.y + (wantTarget.y - camTarget.y) * k, camTarget.z + (wantTarget.z - camTarget.z) * k)
        camDist += (wantDist - camDist) * k
        let dir = SCNVector3(sin(polar) * sin(azimuth), cos(polar), sin(polar) * cos(azimuth))
        camera.position = SCNVector3(camTarget.x + dir.x * camDist, camTarget.y + dir.y * camDist, camTarget.z + dir.z * camDist)
        // world up, every frame: plain look(at:) keeps the node's current up, so roll would creep in while orbiting
        camera.look(at: camTarget, up: SCNVector3(0, 1, 0), localFront: SCNVector3(0, 0, -1))
    }

    private func homeDistance(_ g: OfficeScene.Grid, aspect: Float) -> Float {
        let W = Float(g.w), D = Float(g.d)
        var corners: [SIMD3<Float>] = []
        // homeView()'s fit box: the floor inset by 1.5 / 1 cells, up to 1.1 high
        for x in [Float(1.5), W - 1.5] { for z in [Float(1), D - 1] { for y in [Float(0), 1.1] { corners.append([x, y, z]) } } }
        let target = SIMD3<Float>(W / 2, 0, D / 2)
        let dir = SIMD3<Float>(sin(polar) * sin(azimuth), cos(polar), sin(polar) * cos(azimuth))
        let fwd = -dir, right = simd_normalize(simd_cross(fwd, [0, 1, 0])), up = simd_cross(right, fwd)
        let tanY = tan(Float(15) * .pi / 180) * 0.9, tanX = tanY * aspect * 0.96
        var lo: Float = 5, hi: Float = 200
        for _ in 0..<30 {
            let mid = (lo + hi) / 2
            let eye = target + dir * mid
            let fits = corners.allSatisfy { c in
                let p = c - eye
                let z = simd_dot(p, fwd)
                return z > 0 && abs(simd_dot(p, right) / z) <= tanX && abs(simd_dot(p, up) / z) <= tanY
            }
            if fits { hi = mid } else { lo = mid }
        }
        return hi
    }

    // MARK: pills

    private func placePills() {
        guard let v = view else { return }
        overlay.size = v.bounds.size
        var rects: [Bridge.LabelRect] = []
        for (id, pill) in pills {
            guard let n = agents[id] else { continue }
            let world = n.node.convertPosition(SCNVector3(0, n.crownY + 0.12, 0), to: nil)
            let p = v.projectPoint(world)
            pill.node.isHidden = p.z < 0 || p.z > 1
            pill.node.position = CGPoint(x: CGFloat(p.x), y: v.bounds.height - CGFloat(p.y) + pill.node.size.height / 2)
            pill.node.zPosition = CGFloat(1 - p.z) * 1000
            let sz = pill.labelSize
            rects.append(.init(id: id, x: Double(p.x) - sz.width / 2, y: Double(p.y) - sz.height, w: sz.width, h: sz.height, depth: Double(p.z),
                               status: n.agent.status, selected: follow == id, speaking: n.agent.says != nil, kept: pill.kept))
        }
        guard let keep = try? bridge?.cull(rects) else { return }
        for (id, pill) in pills { pill.setKept(keep.contains(id)) }
    }

    // MARK: remote

    /// Any remote input: stops a tour (dropping the agent it was visiting) and restarts the idle clock.
    func noteInput() {
        lastInput = CACurrentMediaTime()
        if touring { touring = false; follow = nil }
    }

    /// Follow the next (+1) or previous (-1) agent in roster order.
    func step(_ by: Int) {
        let order = (last?.agents ?? []).map(\.id)
        guard !order.isEmpty else { return }
        let i = follow.flatMap { order.firstIndex(of: $0) }
        follow = order[((i ?? (by > 0 ? -1 : 0)) + by + order.count) % order.count]
    }

    func follow(_ id: String) { follow = id }
    func toggleFollow() { follow = follow == nil ? last?.agents.first?.id : nil }
    func unfollow() { follow = nil }

    /// Back to the web's home view of the whole room.
    func home() {
        follow = nil
        zoomGoal = 1
        // the shortest way back round to the home angle
        var d = (Self.homeAzimuth - azimuthGoal).truncatingRemainder(dividingBy: 2 * .pi)
        if d > .pi { d -= 2 * .pi } else if d < -.pi { d += 2 * .pi }
        azimuthGoal += d
    }

    private func refreshPills() {
        if let s = last { for a in s.agents { pills[a.id]?.update(a, selected: follow == a.id) } }
    }

    private func stepTour(now: Double, dt: Float) {
        if !touring, now - lastInput > Self.tourAfter, touch == nil {
            touring = true
            zoomGoal = 1
                _ = last.map(newsworthy)
        }
        guard touring else { return }
        azimuthGoal += dt * 0.06
        if follow != nil, now > tourUntil { follow = nil }
    }

    private func watchControllers() {
        NotificationCenter.default.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { [weak self] n in
            if let c = n.object as? GCController { self?.listen(c) }
        }
        GCController.controllers().forEach(listen)
    }

    private func listen(_ c: GCController) {
        guard let pad = c.microGamepad else { return }
        pad.reportsAbsoluteDpadValues = true
        // The clickpad as a plain 2D touch: moving the finger left/right turns the camera by how far it moved, up/down
        // zooms, both at once. The pad snaps to (0, 0) in its centre dead zone as well as on lift, so a lift only
        // counts after 0.15 s of zeros, and the jump across the dead zone is skipped.
        pad.dpad.valueChangedHandler = { [weak self] _, x, y in
            guard let self else { return }
            if x == 0 && y == 0 {
                guard self.touch != nil, self.liftWork == nil else { return }
                let work = DispatchWorkItem { [weak self] in
                    self?.touch = nil
                    self?.liftWork = nil
                }
                self.liftWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
                return
            }
            let crossedDeadZone = self.liftWork != nil
            self.liftWork?.cancel()
            self.liftWork = nil
            self.noteInput()
            defer { self.touch = SIMD2(x, y) }
            guard let t = self.touch, !crossedDeadZone else { return }
            let dx = x - t.x, dy = y - t.y
            self.azimuthGoal -= dx * 2.2
            self.zoomGoal = min(2.2, max(0.25, self.zoomGoal * exp(-dy * 1.1)))
        }
    }
}

/// The SceneKit view: focusable so it receives the Siri Remote's presses, which it hands to `onPress`. Back (menu) is
/// only swallowed while `consumesMenu` says so; otherwise it reaches the system, which leaves the app.
final class OfficeSCNView: SCNView {
    var onPress: ((UIPress.PressType) -> Void)?
    var consumesMenu: (() -> Bool)?
    var onHoldSelect: (() -> Void)?
    var onHoldPlayPause: (() -> Void)?
    override var canBecomeFocused: Bool { true }

    /// Holds fire while the button is still down (after `holdAfter`), and that press then does nothing on release.
    private static let holdAfter: [UIPress.PressType: Double] = [.playPause: 0.6, .select: 1.2]
    private var holds: [UIPress.PressType: DispatchWorkItem] = [:]
    private var held: Set<UIPress.PressType> = []

    private func startHold(_ type: UIPress.PressType) {
        guard let after = Self.holdAfter[type] else { return }
        held.remove(type)
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.held.insert(type)
            if type == .playPause { self.onHoldPlayPause?() } else { self.onHoldSelect?() }
        }
        holds[type]?.cancel()
        holds[type] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + after, execute: work)
    }

    /// True when this release ends a hold that already fired.
    private func endHold(_ type: UIPress.PressType) -> Bool {
        holds[type]?.cancel()
        holds[type] = nil
        return held.remove(type) != nil
    }

    private func ours(_ p: UIPress) -> Bool { p.type != .menu || consumesMenu?() == true }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for p in presses where ours(p) { startHold(p.type) }
        let rest = presses.filter { !ours($0) }
        if !rest.isEmpty { super.pressesBegan(rest, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var rest = Set<UIPress>()
        for p in presses {
            if ours(p) { if !endHold(p.type) { onPress?(p.type) } } else { rest.insert(p) }
        }
        if !rest.isEmpty { super.pressesEnded(rest, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for p in presses { _ = endHold(p.type) }
        super.pressesCancelled(presses, with: event)
    }
}

/// box at = [centre x, bottom y, centre z], size = [w, h, d] (the web viewer's vbox convention).
func boxNode(at: [Double], size: [Double], color: UIColor) -> SCNNode {
    precondition(at.count == 3 && size.count == 3, "a box needs at[3] and size[3]")
    let g = SCNBox(width: size[0], height: size[1], length: size[2], chamferRadius: 0)
    let m = SCNMaterial()
    m.diffuse.contents = color
    m.lightingModel = .lambert
    g.materials = [m]
    let n = SCNNode(geometry: g)
    n.position = SCNVector3(at[0], at[1] + size[1] / 2, at[2])
    return n
}

