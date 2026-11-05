import SpriteKit
import UIKit

/// An agent's name pill, drawn like the web's .pill (office.css): white tag with a hue underline, emoji, bold name and a
/// status dot; the activity below while working (amber while waiting); a speech bubble above while it says something.
/// Sizes are the web's CSS pixels × `scale`, so the TV reads like the browser at a couch distance.
final class Pill {
    let node = SKSpriteNode()
    private let dotNode = SKShapeNode(circleOfRadius: 5 * Pill.scale)
    private var sig = ""
    private var full: (texture: SKTexture, size: CGSize)?
    private var working = false
    private(set) var kept = true
    /// The tag + activity box the web measures for culling (without the padding around the drawing).
    private(set) var labelSize = CGSize.zero
    private static let scale: CGFloat = 1.45
    private static let dot: [String: UIColor] = [
        "working": cssColor("#4fbf7a"), "idle": cssColor("#8fa6c9"), "waiting": cssColor("#f2b33d"), "away": cssColor("#b4aaa2"),
    ]

    init() {
        node.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        dotNode.lineWidth = 0
        dotNode.isHidden = true
        node.addChild(dotNode)
    }

    /// A culled pill disappears, except a working agent's, which shrinks to a hue dot (office.css .pill.culled.working).
    func setKept(_ k: Bool) {
        kept = k
        node.texture = k ? full?.texture : nil
        node.color = .clear
        node.size = k ? (full?.size ?? .zero) : CGSize(width: 1, height: 1)
        dotNode.isHidden = k || !working
        node.alpha = k || working ? node.alpha : 0
        if k || working { node.alpha = node.alpha == 0 ? 1 : node.alpha }
    }

    func update(_ a: OfficeScene.Agent, selected: Bool) {
        let act: String? = a.status == "working" ? a.activity.map { clip($0, 48) } : a.status == "waiting" ? clip(a.activity ?? "needs input", 48) : nil
        let say = a.says.map { clip($0, 140) }
        let s = "\(a.name)|\(a.emoji ?? "")|\(a.status)|\(act ?? "")|\(say ?? "")|\(a.css)|\(selected)"
        guard s != sig else { return }
        sig = s
        let img = Self.draw(name: a.name, emoji: a.emoji, status: a.status, act: act, say: say, hue: cssColor(a.css), selected: selected)
        full = (SKTexture(image: img), img.size)
        labelSize = CGSize(width: img.size.width - 16 * Self.scale, height: img.size.height - 16 * Self.scale)
        working = a.status == "working"
        dotNode.fillColor = cssColor(a.css)
        node.alpha = a.status == "away" ? 0.75 : 1
        setKept(kept)
    }

    private static func draw(name: String, emoji: String?, status: String, act: String?, say: String?, hue: UIColor, selected: Bool) -> UIImage {
        let k = scale
        let ink = UIColor(red: 0x2b / 255, green: 0x24 / 255, blue: 0x20 / 255, alpha: 1)
        let nameFont = UIFont.systemFont(ofSize: 12 * k, weight: .bold), actFont = UIFont.systemFont(ofSize: 11 * k, weight: .regular)
        let sayFont = UIFont.systemFont(ofSize: 12.5 * k, weight: .regular)
        let label = (emoji.map { "\($0) " } ?? "") + name
        let nameSize = (label as NSString).size(withAttributes: [.font: nameFont])
        let tagW = 6 * k + nameSize.width + 5 * k + 8 * k + 9 * k, tagH = nameSize.height + 6 * k + 2 * k
        let actSize = act.map { ($0 as NSString).size(withAttributes: [.font: actFont]) } ?? .zero
        let actW = act == nil ? 0 : min(210 * k, actSize.width + 16 * k), actH = act == nil ? 0 : actSize.height + 4 * k
        let sayRect = say.map { ($0 as NSString).boundingRect(with: CGSize(width: 208 * k, height: .greatestFiniteMagnitude), options: .usesLineFragmentOrigin, attributes: [.font: sayFont], context: nil) }
        let bubbleW = sayRect.map { $0.width + 22 * k } ?? 0, bubbleH = sayRect.map { $0.height + 14 * k } ?? 0
        let gap = 3 * k, pad = 8 * k
        let w = max(tagW, actW, bubbleW) + pad * 2
        let h = (say == nil ? 0 : bubbleH + 6 * k + gap) + tagH + (act == nil ? 0 : gap + actH) + pad * 2
        let r = UIGraphicsImageRenderer(size: CGSize(width: w, height: h))
        return r.image { ctx in
            let g = ctx.cgContext
            var y = pad
            if let say, let sayRect {
                let rect = CGRect(x: (w - bubbleW) / 2, y: y, width: bubbleW, height: bubbleH)
                g.setShadow(offset: CGSize(width: 0, height: 4 * k), blur: 14 * k, color: UIColor(red: 0.24, green: 0.16, blue: 0.08, alpha: 0.2).cgColor)
                UIColor.white.setFill()
                UIBezierPath(roundedRect: rect, cornerRadius: 14 * k).fill()
                let tail = UIBezierPath()
                tail.move(to: CGPoint(x: w / 2 - 6 * k, y: rect.maxY - 1))
                tail.addLine(to: CGPoint(x: w / 2, y: rect.maxY + 6 * k))
                tail.addLine(to: CGPoint(x: w / 2 + 6 * k, y: rect.maxY - 1))
                tail.fill()
                g.setShadow(offset: .zero, blur: 0)
                (say as NSString).draw(with: CGRect(x: rect.minX + 11 * k, y: rect.minY + 7 * k, width: sayRect.width, height: sayRect.height),
                                       options: .usesLineFragmentOrigin, attributes: [.font: sayFont, .foregroundColor: ink], context: nil)
                y += bubbleH + 6 * k + gap
            }
            let tag = CGRect(x: (w - tagW) / 2, y: y, width: tagW, height: tagH)
            g.setShadow(offset: CGSize(width: 0, height: 2 * k), blur: 8 * k, color: UIColor(red: 0.24, green: 0.16, blue: 0.08, alpha: 0.18).cgColor)
            hue.setFill()
            UIBezierPath(roundedRect: tag, cornerRadius: tagH / 2).fill()
            g.setShadow(offset: .zero, blur: 0)
            UIColor(red: 1, green: 252 / 255, blue: 247 / 255, alpha: 1).setFill()
            UIBezierPath(roundedRect: CGRect(x: tag.minX, y: tag.minY, width: tag.width, height: tag.height - 2 * k), cornerRadius: (tagH - 2 * k) / 2).fill()
            if selected {
                hue.setStroke()
                let o = UIBezierPath(roundedRect: tag.insetBy(dx: -3 * k, dy: -3 * k), cornerRadius: tagH / 2 + 3 * k)
                o.lineWidth = 2 * k
                o.stroke()
            }
            (label as NSString).draw(at: CGPoint(x: tag.minX + 6 * k + 2 * k, y: tag.minY + 3 * k), withAttributes: [.font: nameFont, .foregroundColor: ink])
            (dot[status] ?? dot["away"]!).setFill()
            UIBezierPath(ovalIn: CGRect(x: tag.maxX - 9 * k - 8 * k, y: tag.midY - 4 * k - 1 * k, width: 8 * k, height: 8 * k)).fill()
            y += tagH + gap
            if let act {
                let rect = CGRect(x: (w - actW) / 2, y: y, width: actW, height: actH)
                (status == "waiting" ? cssColor("#f2b33d") : UIColor(red: 43 / 255, green: 36 / 255, blue: 32 / 255, alpha: 0.78)).setFill()
                UIBezierPath(roundedRect: rect, cornerRadius: 8 * k).fill()
                (act as NSString).draw(with: rect.insetBy(dx: 8 * k, dy: 2 * k), options: [.truncatesLastVisibleLine, .usesLineFragmentOrigin],
                                       attributes: [.font: actFont, .foregroundColor: status == "waiting" ? cssColor("#3a2a10") : UIColor.white], context: nil)
            }
        }
    }
}

private func clip(_ s: String, _ n: Int) -> String { s.count <= n ? s : String(s.prefix(n - 1)) + "…" }
