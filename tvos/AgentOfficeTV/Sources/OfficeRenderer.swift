import GameController
import SceneKit
import SpriteKit
import UIKit

/// Draws an OfficeScene with SceneKit, matching the web viewer: same furniture boxes, same characters and poses, the
/// web's A* walks, its 3/4 home camera, and DOM-style name pills kept at a constant screen size.
final class OfficeRenderer: NSObject {
    let scene = SCNScene()
    let camera = SCNNode()
    weak var bridge: Bridge?
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
    private var azimuth: Float = .pi / 4.6
    private var polar: Float = 0.93
    private var zoom: Float = 1
    private var camTarget = SCNVector3Zero
    private var camDist: Float = 30
    private(set) var follow: String?
    private var touch: (mode: TouchMode, x: Float, y: Float, angle: Float)?
    private enum TouchMode { case drag, wheel }

    override init() {
        super.init()
        scene.background.contents = UIColor(red: 0.78, green: 0.88, blue: 0.96, alpha: 1)
        for n in [room, furniture, people] { scene.rootNode.addChildNode(n) }
        camera.camera = SCNCamera()
        camera.camera?.fieldOfView = 30
        camera.camera?.projectionDirection = .vertical
        camera.camera?.zNear = 0.5
        camera.camera?.zFar = 400
        scene.rootNode.addChildNode(camera)
        let sun = SCNNode()
        sun.light = SCNLight()
        sun.light?.type = .directional
        sun.light?.intensity = 700
        sun.light?.color = UIColor(red: 1, green: 0.98, blue: 0.95, alpha: 1)
        sun.light?.castsShadow = true
        sun.light?.shadowMode = .forward
        sun.light?.shadowRadius = 2
        sun.light?.shadowSampleCount = 4
        sun.light?.shadowMapSize = CGSize(width: 4096, height: 4096)
        sun.light?.shadowBias = 0.05
        sun.light?.shadowColor = UIColor(red: 0.25, green: 0.15, blue: 0.05, alpha: 0.3)
        sun.light?.automaticallyAdjustsShadowProjection = false
        sun.eulerAngles = SCNVector3(-0.95, 0.75, 0)
        scene.rootNode.addChildNode(sun)
        self.sun = sun
        let fill = SCNNode()
        fill.light = SCNLight()
        fill.light?.type = .ambient
        fill.light?.intensity = 600
        fill.light?.color = UIColor(white: 1, alpha: 1)
        scene.rootNode.addChildNode(fill)
        overlay.scaleMode = .resizeFill
        overlay.backgroundColor = .clear
    }

    func attach(_ v: OfficeSCNView) {
        view = v
        v.scene = scene
        v.pointOfView = camera
        v.overlaySKScene = overlay
        v.input = self
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
        let structural = last == nil || last!.grid != s.grid || last!.theme != s.theme || last!.wallH != s.wallH
        if structural { buildRoom(s) }
        if structural || last!.items != s.items || last!.kinds != s.kinds { buildFurniture(s) }
        syncAgents(s)
        if follow.map({ id in !s.agents.contains { $0.id == id } }) == true { follow = nil }
        last = s
    }

    // MARK: room

    private func buildRoom(_ s: OfficeScene) {
        room.childNodes.forEach { $0.removeFromParentNode() }
        let w = Double(s.grid.w), d = Double(s.grid.d)
        // a fixed shadow box over the room: the sun sits back along its own direction from the floor's centre
        let back = sun.worldFront * -40
        sun.position = SCNVector3(Float(w / 2) + back.x, back.y, Float(d / 2) + back.z)
        sun.light?.orthographicScale = CGFloat(max(w, d)) * 0.62
        sun.light?.zNear = 1
        sun.light?.zFar = 90
        room.addChildNode(boxNode(at: [w / 2, -0.46, d / 2], size: [w + 60, 0.1, d + 60], color: UIColor(red: 0.53, green: 0.75, blue: 0.42, alpha: 1)))
        room.addChildNode(boxNode(at: [w / 2, -0.34, d / 2], size: [w + 0.6, 0.23, d + 0.6], color: UIColor(red: 0.62, green: 0.55, blue: 0.47, alpha: 1)))
        room.addChildNode(boxNode(at: [w / 2, -0.1, d / 2], size: [w, 0.1, d], color: cssColor(s.theme.floor.color)))
        let wall = cssColor(s.theme.walls.color), trim = cssColor(s.theme.walls.trim)
        room.addChildNode(boxNode(at: [w / 2 - 0.15, 0, -0.15], size: [w + 0.3, s.wallH, 0.3], color: wall))
        room.addChildNode(boxNode(at: [-0.15, 0, d / 2], size: [0.3, s.wallH, d], color: wall))
        room.addChildNode(boxNode(at: [w / 2 - 0.15, s.wallH, -0.15], size: [w + 0.4, 0.1, 0.4], color: trim))
        room.addChildNode(boxNode(at: [-0.15, s.wallH, d / 2], size: [0.4, 0.1, d], color: trim))
        room.addChildNode(boxNode(at: [w / 2, 0, 0.0], size: [w, 0.12, 0.06], color: trim))
        room.addChildNode(boxNode(at: [0.0, 0, d / 2], size: [0.06, 0.12, d], color: trim))
    }

    // MARK: furniture

    private func buildFurniture(_ s: OfficeScene) {
        furniture.childNodes.forEach { $0.removeFromParentNode() }
        for item in s.items {
            guard let kind = s.kinds[item.kind] else { preconditionFailure("scene has item \(item.id) of unknown kind \(item.kind)") }
            let node = model(of: kind, item: item, theme: s.theme)
            node.position = SCNVector3(item.x, 0, item.z)
            node.eulerAngles.y = Float(item.yaw)
            furniture.addChildNode(node)
        }
    }

    private func model(of kind: OfficeScene.Kind, item: OfficeScene.Item, theme: OfficeScene.Theme) -> SCNNode {
        let node = SCNNode()
        let accent = cssColor(item.color ?? kind.defaultColor ?? "#ffffff")
        for part in kind.parts {
            for b in part.boxes {
                let base = cssColor(b.color ?? "#ffffff")
                let color: UIColor = switch part.role {
                case "accent": multiply(base, accent)
                case "finish": multiply(base, cssColor(theme.desk.wood))
                case "rail": multiply(base, cssColor(theme.desk.rail))
                case "glow": kind.glowColor.map(cssColor) ?? UIColor(red: 0.62, green: 0.82, blue: 1, alpha: 1)
                default: base
                }
                let n = boxNode(at: b.at, size: b.size, color: color)
                if part.role == "glow" { n.geometry?.firstMaterial?.emission.contents = color }
                if part.role == "glass" { n.geometry?.firstMaterial?.transparency = 0.45 }
                node.addChildNode(n)
            }
        }
        return node.flattenedClone()
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
                let n = AgentNode(a)
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
        let list = Array(agents.values)
        for n in list { n.step(dt: Float(dt)) }
        if let angles = try? bridge?.limbs(list.map { ($0.pose, $0.agent.phase) }, t: clock), angles.count == list.count {
            for (n, a) in zip(list, angles) { n.apply(a, clock: clock) }
        }
        placeCamera(dt: Float(dt))
        placePills()
    }

    // MARK: camera

    /// Home: the whole room (walls included) fits the screen, as homeView() frames it on the web. Following: close behind the agent.
    private func placeCamera(dt: Float) {
        guard let s = last, let v = view, v.bounds.height > 0 else { return }
        let aspect = Float(v.bounds.width / v.bounds.height)
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
        camera.look(at: camTarget)
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

    /// Arrows pick the agent to follow (up goes home); the clickpad's outer ring turns the camera like an iPod wheel.
    func press(_ type: UIPress.PressType) -> Bool {
        let order = (last?.agents ?? []).map(\.id)
        switch type {
        case .rightArrow, .leftArrow:
            guard !order.isEmpty else { return true }
            let i = follow.flatMap { order.firstIndex(of: $0) }
            let step = type == .rightArrow ? 1 : -1
            follow = order[((i ?? (step > 0 ? -1 : 0)) + step + order.count) % order.count]
        case .upArrow:
            follow = nil
            zoom = 1
            polar = 0.93
            azimuth = .pi / 4.6
        case .select:
            follow = follow == nil ? order.first : nil
        default:
            return false
        }
        if let s = last { for a in s.agents { pills[a.id]?.update(a, selected: follow == a.id) } }
        return true
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
        // A touch that starts on the outer ring is a wheel (circle clockwise to zoom in); anywhere else it drags the
        // camera: left/right orbits, up/down tilts. Lifting the finger reports (0, 0).
        pad.dpad.valueChangedHandler = { [weak self] _, x, y in
            guard let self else { return }
            if x == 0 && y == 0 { self.touch = nil; return }
            let r = (x * x + y * y).squareRoot(), a = atan2(y, x)
            guard let t = self.touch else {
                self.touch = (r > 0.75 ? .wheel : .drag, x, y, a)
                return
            }
            switch t.mode {
            case .drag:
                self.azimuth -= (x - t.x) * 1.6
                self.polar = min(1.35, max(0.3, self.polar + (y - t.y) * 0.9))
            case .wheel:
                var d = a - t.angle
                while d > .pi { d -= 2 * .pi }
                while d < -.pi { d += 2 * .pi }
                self.zoom = min(2.2, max(0.25, self.zoom * exp(d * 0.35)))
            }
            self.touch = (t.mode, x, y, a)
        }
    }
}

/// The SceneKit view: focusable so it receives the Siri Remote's presses.
final class OfficeSCNView: SCNView {
    weak var input: OfficeRenderer?
    var onPlayPause: (() -> Void)?
    var onHoldSelect: (() -> Void)?
    override var canBecomeFocused: Bool { true }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard gestureRecognizers?.isEmpty ?? true else { return }
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.allowedPressTypes = [NSNumber(value: UIPress.PressType.select.rawValue)]
        hold.minimumPressDuration = 1.2
        addGestureRecognizer(hold)
    }

    @objc private func held(_ g: UILongPressGestureRecognizer) {
        if g.state == .began { onHoldSelect?() }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var rest = Set<UIPress>()
        for p in presses {
            if p.type == .playPause { onPlayPause?(); continue }
            if input?.press(p.type) != true { rest.insert(p) }
        }
        if !rest.isEmpty { super.pressesEnded(rest, with: event) }
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

private func multiply(_ a: UIColor, _ b: UIColor) -> UIColor {
    var (r1, g1, b1, a1, r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0, 0, 0, 0, 0)
    a.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
    b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
    return UIColor(red: r1 * r2, green: g1 * g2, blue: b1 * b2, alpha: 1)
}
