import SceneKit
import UIKit

/// One character built from the web viewer's characterRig() and posed with its limbAngles(), walking the web's A* path.
final class AgentNode {
    let node = SCNNode()
    private(set) var agent: OfficeScene.Agent
    private var parts: [String: SCNNode] = [:]
    private var props: [String: SCNNode] = [:]
    private var path: [(Double, Double)] = []
    private var targetKey = ""
    private let voxel: Voxel
    private(set) var walking = false

    /// The web viewer's walk speed (scene.js WALK_SPEED) and which poses hold which hand prop (character.js POSE_PROPS).
    static let walkSpeed: Float = 1.7
    private static let poseProps = ["sip": "mug", "coffee": "mug", "snack": "snack", "read": "book", "water-plants": "can", "whiteboard": "marker"]

    init(_ a: OfficeScene.Agent, voxel: Voxel) {
        agent = a
        self.voxel = voxel
        build(a.rig)
        node.position = SCNVector3(a.target.x, 0, a.target.z)
        node.eulerAngles.y = Float(a.target.yaw)
        targetKey = a.target.key
        node.opacity = a.status == "away" ? 0.55 : 1
    }

    var pose: String { walking ? "walk" : agent.target.pose }
    var crownY: Float { (parts["hips"]?.position.y ?? 0.4) + 0.46 + 0.46 + 0.06 }

    private func build(_ rig: OfficeScene.Rig) {
        parts.values.forEach { $0.removeFromParentNode() }
        parts = [:]
        props = [:]
        var pending = rig.parts
        while !pending.isEmpty {
            let ready = pending.filter { $0.value.parent == nil || parts[$0.value.parent!] != nil }
            precondition(!ready.isEmpty, "characterRig has a part whose parent never appears")
            for (name, part) in ready {
                let g = SCNNode()
                g.position = SCNVector3(part.at[0], part.at[1], part.at[2])
                if !part.boxes.isEmpty { g.addChildNode(mesh(part.boxes, ao: name != "eyes")) }
                if let face = part.face { g.addChildNode(mesh(face, ao: false)) }
                (part.parent.flatMap { parts[$0] } ?? node).addChildNode(g)
                parts[name] = g
                pending[name] = nil
            }
        }
        for (name, prop) in rig.props {
            guard let parent = parts[prop.parent] else { preconditionFailure("prop \(name) hangs on missing part \(prop.parent)") }
            let g = SCNNode()
            g.addChildNode(mesh(prop.boxes, ao: false))
            g.isHidden = true
            parent.addChildNode(g)
            props[name] = g
        }
    }

    /// character.js buildCharacter's meshes: voxel.js geometry with the grain texture, AO measured off the floor.
    private func mesh(_ boxes: [OfficeScene.Box], ao: Bool) -> SCNNode {
        do {
            let g = try voxel.geometry(boxes, ao: ao, floorY: -99)
            g.firstMaterial = voxel.material(map: try voxel.texture("grain"))
            return SCNNode(geometry: g)
        } catch {
            preconditionFailure("character mesh failed: \(error)")
        }
    }

    func update(_ a: OfficeScene.Agent, route: (_ from: (Double, Double), _ to: (Double, Double)) -> [(Double, Double)]) {
        if a.rig != agent.rig { build(a.rig) }
        if a.target.key != targetKey {
            targetKey = a.target.key
            path = route((Double(node.position.x), Double(node.position.z)), (a.target.x, a.target.z))
        }
        node.opacity = a.status == "away" ? 0.55 : 1
        agent = a
    }

    func step(dt: Float) {
        let t = agent.target
        if path.isEmpty, hypot(Float(t.x) - node.position.x, Float(t.z) - node.position.z) > 0.02 { path = [(t.x, t.z)] }
        walking = !path.isEmpty
        guard let wp = path.first else {
            turn(toward: Float(t.yaw), rate: 8, dt: dt)
            return
        }
        let dx = Float(wp.0) - node.position.x, dz = Float(wp.1) - node.position.z
        let dist = (dx * dx + dz * dz).squareRoot()
        let s = Self.walkSpeed * dt
        if dist <= s {
            node.position.x = Float(wp.0)
            node.position.z = Float(wp.1)
            path.removeFirst()
        } else {
            node.position.x += dx / dist * s
            node.position.z += dz / dist * s
        }
        if dist > 0.01 { turn(toward: atan2(dx, dz), rate: 10, dt: dt) }
    }

    /// character.js applyLimbs + applyProps + blink.
    func apply(_ a: LimbAngles, clock: Double) {
        parts["legL"]?.eulerAngles.x = Float(a.legL)
        parts["legR"]?.eulerAngles.x = Float(a.legR)
        parts["armL"]?.eulerAngles = SCNVector3(Float(a.armL), 0, Float(a.armLz))
        parts["armR"]?.eulerAngles = SCNVector3(Float(a.armR), 0, Float(-a.armRz))
        parts["head"]?.eulerAngles = SCNVector3(Float(a.headTilt), Float(a.head), 0)
        parts["torso"]?.eulerAngles.x = Float(a.lean)
        parts["hips"]?.position.y = Float((a.seated ? agent.target.seatY + 0.02 : 0.4) + a.bob)
        let want = Self.poseProps[pose]
        for (name, p) in props { p.isHidden = name != want }
        let k = (clock + agent.phase * 3.7).truncatingRemainder(dividingBy: 4.2)
        parts["eyes"]?.scale.y = k < 0.12 ? 0.15 : 1
    }

    private func turn(toward yaw: Float, rate: Float, dt: Float) {
        var d = yaw - node.eulerAngles.y
        while d > .pi { d -= 2 * .pi }
        while d < -.pi { d += 2 * .pi }
        node.eulerAngles.y += d * min(1, dt * rate)
    }
}
