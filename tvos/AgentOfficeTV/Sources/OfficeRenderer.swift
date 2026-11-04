import SceneKit
import UIKit

/// Draws an OfficeScene with SceneKit: floor, two walls, furniture from the bridge's box lists, and blocky agents that
/// walk to the targets the bridge picks.
final class OfficeRenderer: NSObject, SCNSceneRendererDelegate {
    let scene = SCNScene()
    let camera = SCNNode()
    private let room = SCNNode()
    private let furniture = SCNNode()
    private let people = SCNNode()
    private var kindTemplates: [String: SCNNode] = [:]
    private var last: OfficeScene?
    private var agents: [String: AgentNode] = [:]
    private var lastTick: TimeInterval = 0
    private var orbit: Float = 0.6

    private static let walkSpeed: Float = 1.6

    override init() {
        super.init()
        scene.background.contents = UIColor(red: 0.74, green: 0.86, blue: 0.95, alpha: 1)
        for n in [room, furniture, people] { scene.rootNode.addChildNode(n) }
        camera.camera = SCNCamera()
        camera.camera?.fieldOfView = 38
        camera.camera?.zFar = 200
        scene.rootNode.addChildNode(camera)
        let sun = SCNNode()
        sun.light = SCNLight()
        sun.light?.type = .directional
        sun.light?.intensity = 900
        sun.light?.castsShadow = true
        sun.light?.shadowRadius = 4
        sun.light?.shadowColor = UIColor(white: 0, alpha: 0.35)
        sun.eulerAngles = SCNVector3(-1.0, 0.6, 0)
        scene.rootNode.addChildNode(sun)
        let fill = SCNNode()
        fill.light = SCNLight()
        fill.light?.type = .ambient
        fill.light?.intensity = 420
        scene.rootNode.addChildNode(fill)
    }

    /// Swipes on the Siri remote turn the camera around the office.
    func turn(by delta: Float) {
        orbit += delta
        if let s = last { placeCamera(s.grid) }
    }

    func apply(_ s: OfficeScene) {
        let structural = last == nil || last!.grid != s.grid || last!.theme != s.theme || last!.wallH != s.wallH
        let itemsChanged = structural || last!.items != s.items || last!.kinds != s.kinds
        if structural { buildRoom(s); placeCamera(s.grid) }
        if itemsChanged { buildFurniture(s) }
        syncAgents(s)
        last = s
    }

    // MARK: room

    private func buildRoom(_ s: OfficeScene) {
        room.childNodes.forEach { $0.removeFromParentNode() }
        let w = Double(s.grid.w), d = Double(s.grid.d)
        room.addChildNode(boxNode(at: [w / 2, -0.1, d / 2], size: [w, 0.1, d], color: cssColor(s.theme.floor.color)))
        let wall = cssColor(s.theme.walls.color), trim = cssColor(s.theme.walls.trim)
        room.addChildNode(boxNode(at: [w / 2, 0, -0.1], size: [w + 0.2, s.wallH, 0.2], color: wall))
        room.addChildNode(boxNode(at: [-0.1, 0, d / 2], size: [0.2, s.wallH, d], color: wall))
        room.addChildNode(boxNode(at: [w / 2, s.wallH, -0.1], size: [w + 0.3, 0.08, 0.3], color: trim))
        room.addChildNode(boxNode(at: [-0.1, s.wallH, d / 2], size: [0.3, 0.08, d], color: trim))
        let grass = boxNode(at: [w / 2, -0.25, d / 2], size: [w + 12, 0.1, d + 12], color: UIColor(red: 0.45, green: 0.7, blue: 0.35, alpha: 1))
        room.addChildNode(grass)
    }

    private func placeCamera(_ g: OfficeScene.Grid) {
        let cx = Float(g.w) / 2, cz = Float(g.d) / 2
        let r = Float(max(g.w, g.d)) * 0.78
        camera.position = SCNVector3(cx + r * sin(orbit), r * 0.9, cz + r * cos(orbit))
        camera.look(at: SCNVector3(cx, 0, cz))
    }

    // MARK: furniture

    private func buildFurniture(_ s: OfficeScene) {
        furniture.childNodes.forEach { $0.removeFromParentNode() }
        kindTemplates = [:]
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
                case "glow": kind.glowColor.map(cssColor) ?? UIColor(red: 0.55, green: 0.75, blue: 0.95, alpha: 1)
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
            n.node.runAction(.sequence([.scale(to: 0.01, duration: 0.4), .removeFromParentNode()]))
            agents[id] = nil
        }
        for a in s.agents {
            if let n = agents[a.id] {
                n.update(a)
            } else {
                let n = AgentNode(a)
                n.node.position = SCNVector3(a.target.x, 0, a.target.z)
                people.addChildNode(n.node)
                agents[a.id] = n
            }
        }
    }

    func renderer(_ renderer: any SCNSceneRenderer, updateAtTime time: TimeInterval) {
        let dt = Float(lastTick == 0 ? 0 : min(0.1, time - lastTick))
        lastTick = time
        for n in agents.values { n.step(dt: dt, speed: Self.walkSpeed) }
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
