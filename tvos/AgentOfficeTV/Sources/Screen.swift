import UIKit

/// screen.js output: a small pixel screen as paint ops (rects and monospace text; text y is the baseline).
struct ScreenSpec: Decodable {
    struct Op: Decodable { let op: String; let x, y: Double; let w, h, size: Double?; let color: String; let text: String?; let bold: Bool? }
    let w, h: Double
    let ops: [Op]
}

/// Paints a ScreenSpec like the web's canvas does.
enum ScreenPainter {
    static func image(_ spec: ScreenSpec) -> UIImage {
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 2
        return UIGraphicsImageRenderer(size: CGSize(width: spec.w, height: spec.h), format: fmt).image { _ in
            for o in spec.ops {
                switch o.op {
                case "rect":
                    guard let w = o.w, let h = o.h else { preconditionFailure("screen rect without w/h") }
                    cssColor(o.color).setFill()
                    UIRectFill(CGRect(x: o.x, y: o.y, width: w, height: h))
                case "text":
                    guard let t = o.text, let size = o.size else { preconditionFailure("screen text without text/size") }
                    let font = UIFont.monospacedSystemFont(ofSize: size, weight: o.bold == true ? .bold : .regular)
                    // canvas fillText draws at the baseline; UIKit at the top of the line box
                    (t as NSString).draw(at: CGPoint(x: o.x, y: o.y - font.ascender), withAttributes: [.font: font, .foregroundColor: cssColor(o.color)])
                default:
                    preconditionFailure("unknown screen op \(o.op)")
                }
            }
        }
    }
}
