import UIKit

/// textures.js textTexture / logoTextTexture / logoScreenTexture with UIKit: poster, whiteboard and sign panels, and the
/// office logo on screens. Sizes are the web canvas pixels; drawn at 2× for the couch distance.
enum TextPainter {
    private static func font(_ size: CGFloat) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: .bold)
        return base.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: size) } ?? base
    }

    private static func renderer(_ w: CGFloat, _ h: CGFloat) -> UIGraphicsImageRenderer {
        let f = UIGraphicsImageRendererFormat()
        f.scale = 2
        f.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: f)
    }

    /// Word-wrapped, centred, the biggest size from 30 down to 8 that fits inside a 12 px margin.
    static func text(_ text: String, bg: UIColor, fg: UIColor, w: CGFloat, h: CGFloat) -> UIImage {
        renderer(w, h).image { _ in
            bg.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: w, height: h))
            let pad: CGFloat = 12
            var size: CGFloat = 30
            while true {
                let f = font(size)
                let width = { (s: String) in (s as NSString).size(withAttributes: [.font: f]).width }
                var lines: [String] = []
                for para in text.components(separatedBy: "\n") {
                    var line = ""
                    for word in para.split(whereSeparator: \.isWhitespace).map(String.init) {
                        let next = line.isEmpty ? word : "\(line) \(word)"
                        if width(next) > w - pad * 2 && !line.isEmpty { lines.append(line); line = word } else { line = next }
                    }
                    lines.append(line)
                }
                let lh = size * 1.15
                if CGFloat(lines.count) * lh <= h - pad * 2 || size <= 8 {
                    let y0 = (h - CGFloat(lines.count) * lh) / 2
                    for (i, ln) in lines.enumerated() {
                        (ln as NSString).draw(at: CGPoint(x: (w - width(ln)) / 2, y: y0 + CGFloat(i) * lh), withAttributes: [.font: f, .foregroundColor: fg])
                    }
                    return
                }
                size -= 2
            }
        }
    }

    /// A sign with the logo on top and the text (if any) underneath.
    static func logoText(_ logo: UIImage, _ text: String, bg: UIColor, fg: UIColor, w: CGFloat, h: CGFloat) -> UIImage {
        renderer(w, h).image { _ in
            bg.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: w, height: h))
            let line = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            let box = CGSize(width: w * 0.8, height: h * (line.isEmpty ? 0.78 : 0.5))
            let s = min(box.width / logo.size.width, box.height / logo.size.height)
            let dw = logo.size.width * s, dh = logo.size.height * s
            logo.draw(in: CGRect(x: (w - dw) / 2, y: line.isEmpty ? (h - dh) / 2 : h * 0.08 + (box.height - dh) / 2, width: dw, height: dh))
            guard !line.isEmpty else { return }
            var size = (h * 0.16).rounded()
            var f = font(size)
            while (line as NSString).size(withAttributes: [.font: f]).width > w * 0.88 && size > 8 { size -= 2; f = font(size) }
            let sz = (line as NSString).size(withAttributes: [.font: f])
            (line as NSString).draw(at: CGPoint(x: (w - min(sz.width, w * 0.9)) / 2, y: h * 0.78 - sz.height / 2), withAttributes: [.font: f, .foregroundColor: fg])
        }
    }

    /// A screen showing the logo centred on the theme's screen background.
    static func logoScreen(_ logo: UIImage, bg: UIColor, w: CGFloat = 512, h: CGFloat = 288, fit: CGFloat = 0.72) -> UIImage {
        renderer(w, h).image { _ in
            bg.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: w, height: h))
            let s = min(w * fit / logo.size.width, h * fit / logo.size.height)
            let dw = logo.size.width * s, dh = logo.size.height * s
            logo.draw(in: CGRect(x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh))
        }
    }
}
