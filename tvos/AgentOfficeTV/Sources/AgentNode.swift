import SceneKit
import UIKit

/// One blocky character (proportions from the web viewer's character.js) with a name tag; walks straight to its target.
final class AgentNode {
    let node = SCNNode()
    private let body = SCNNode()
    private let legs = SCNNode()
    private let tag = SCNNode()
    private var agent: OfficeScene.Agent

    private static let legH = 0.4, bodyH = 0.46, head = 0.46
    private static let seated: Set<String> = ["type", "handup", "doze", "sit", "lounge"]

    init(_ a: OfficeScene.Agent) {
        agent = a
        let look = a.look
        legs.addChildNode(boxNode(at: [-0.11, 0, 0], size: [0.18, Self.legH, 0.2], color: cssColor(look.pants)))
        legs.addChildNode(boxNode(at: [0.11, 0, 0], size: [0.18, Self.legH, 0.2], color: cssColor(look.pants)))
        body.addChildNode(boxNode(at: [0, 0, 0], size: [0.46, Self.bodyH, 0.26], color: cssColor(look.shirt)))
        body.addChildNode(boxNode(at: [-0.3, 0.06, 0], size: [0.13, 0.4, 0.16], color: cssColor(look.shirtDark)))
        body.addChildNode(boxNode(at: [0.3, 0.06, 0], size: [0.13, 0.4, 0.16], color: cssColor(look.shirtDark)))
        body.addChildNode(boxNode(at: [0, Self.bodyH, 0], size: [Self.head, Self.head, Self.head], color: cssColor(look.skin)))
        body.addChildNode(boxNode(at: [0, Self.bodyH + Self.head - 0.1, -0.02], size: [Self.head + 0.04, 0.14, Self.head + 0.04], color: cssColor(look.hair)))
        body.addChildNode(boxNode(at: [-0.1, Self.bodyH + 0.26, Self.head / 2 + 0.005], size: [0.06, 0.08, 0.01], color: .black))
        body.addChildNode(boxNode(at: [0.1, Self.bodyH + 0.26, Self.head / 2 + 0.005], size: [0.06, 0.08, 0.01], color: .black))
        node.addChildNode(legs)
        node.addChildNode(body)
        let billboard = SCNBillboardConstraint()
        billboard.freeAxes = .all
        tag.constraints = [billboard]
        node.addChildNode(tag)
        node.castsShadow = true
        update(a)
        node.eulerAngles.y = Float(a.target.yaw)
    }

    func update(_ a: OfficeScene.Agent) {
        let relabel = a.name != agent.name || a.status != agent.status || a.activity != agent.activity || tag.geometry == nil
        agent = a
        if relabel { drawTag() }
    }

    func step(dt: Float, speed: Float) {
        let t = agent.target
        let dx = Float(t.x) - node.position.x, dz = Float(t.z) - node.position.z
        let dist = (dx * dx + dz * dz).squareRoot()
        let walking = dist > 0.02
        if walking {
            let s = min(dist, speed * dt)
            node.position.x += dx / dist * s
            node.position.z += dz / dist * s
            turn(toward: atan2(dx, dz), dt: dt)
        } else {
            turn(toward: Float(t.yaw), dt: dt)
        }
        pose(walking ? "walk" : t.pose, seatY: Float(t.seatY))
    }

    private func turn(toward yaw: Float, dt: Float) {
        var d = yaw - node.eulerAngles.y
        while d > .pi { d -= 2 * .pi }
        while d < -.pi { d += 2 * .pi }
        node.eulerAngles.y += d * min(1, dt * 8)
    }

    private func pose(_ p: String, seatY: Float) {
        if Self.seated.contains(p) {
            body.position.y = seatY - 0.02
            legs.position = SCNVector3(0, seatY - 0.1, 0.12)
            legs.eulerAngles.x = -.pi / 2
            legs.scale = SCNVector3(1, 0.9, 1)
        } else {
            body.position.y = Float(Self.legH)
            legs.position = SCNVector3(0, 0, 0)
            legs.eulerAngles.x = 0
            legs.scale = SCNVector3(1, 1, 1)
        }
        let bob: Float = p == "walk" ? abs(sin(Float(CACurrentMediaTime()) * 10)) * 0.04 : 0
        body.position.y += bob
        tag.position = SCNVector3(0, body.position.y + Float(Self.bodyH + Self.head) + 0.45, 0)
    }

    private func drawTag() {
        let status: String = switch agent.status {
        case "working": agent.activity ?? "working"
        case "waiting": "needs input"
        case "away": "away"
        default: ""
        }
        let dot: UIColor = switch agent.status {
        case "working": UIColor(red: 0.3, green: 0.8, blue: 0.45, alpha: 1)
        case "waiting": UIColor(red: 1, green: 0.7, blue: 0.2, alpha: 1)
        case "away": UIColor(white: 0.6, alpha: 1)
        default: UIColor(red: 0.45, green: 0.6, blue: 0.95, alpha: 1)
        }
        let name = agent.name as NSString
        let font = UIFont.systemFont(ofSize: 34, weight: .semibold), small = UIFont.systemFont(ofSize: 26, weight: .medium)
        let nameW = name.size(withAttributes: [.font: font]).width
        let statusW = status.isEmpty ? 0 : (status as NSString).size(withAttributes: [.font: small]).width
        let w = max(nameW + 76, statusW + 40), h: CGFloat = status.isEmpty ? 64 : 108
        let img = UIGraphicsImageRenderer(size: CGSize(width: w, height: h)).image { _ in
            UIColor(white: 1, alpha: 0.94).setFill()
            UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: w, height: 64), cornerRadius: 32).fill()
            dot.setFill()
            UIBezierPath(ovalIn: CGRect(x: 20, y: 22, width: 20, height: 20)).fill()
            name.draw(at: CGPoint(x: 52, y: 12), withAttributes: [.font: font, .foregroundColor: UIColor(white: 0.12, alpha: 1)])
            if !status.isEmpty {
                dot.withAlphaComponent(0.92).setFill()
                UIBezierPath(roundedRect: CGRect(x: (w - statusW - 28) / 2, y: 70, width: statusW + 28, height: 36), cornerRadius: 18).fill()
                (status as NSString).draw(at: CGPoint(x: (w - statusW) / 2, y: 73), withAttributes: [.font: small, .foregroundColor: UIColor.white])
            }
        }
        let scale: CGFloat = 0.011
        let plane = SCNPlane(width: w * scale, height: h * scale)
        let m = SCNMaterial()
        m.diffuse.contents = img
        m.lightingModel = .constant
        m.isDoubleSided = true
        m.readsFromDepthBuffer = false
        plane.materials = [m]
        tag.geometry = plane
        tag.renderingOrder = 100
    }
}
