import UIKit

/// "#rrggbb" and CSS "hsl(h s% l%)" (what the office uses) → UIColor. Anything else is a bug upstream: fail loudly.
func cssColor(_ s: String) -> UIColor {
    let t = s.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("#"), t.count == 7, let v = UInt32(t.dropFirst(), radix: 16) {
        return UIColor(red: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
    }
    if t.hasPrefix("hsl(") {
        let nums = t.dropFirst(4).dropLast().replacingOccurrences(of: "%", with: "").replacingOccurrences(of: ",", with: " ")
            .split(separator: " ").compactMap { Double($0) }
        if nums.count == 3 { return hsl(nums[0], nums[1] / 100, nums[2] / 100) }
    }
    preconditionFailure("unsupported colour \(s)")
}

private func hsl(_ h: Double, _ s: Double, _ l: Double) -> UIColor {
    let c = (1 - abs(2 * l - 1)) * s
    let hp = (h.truncatingRemainder(dividingBy: 360)) / 60
    let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
    let (r, g, b): (Double, Double, Double) = switch hp {
    case 0..<1: (c, x, 0)
    case 1..<2: (x, c, 0)
    case 2..<3: (0, c, x)
    case 3..<4: (0, x, c)
    case 4..<5: (x, 0, c)
    default: (c, 0, x)
    }
    let m = l - c / 2
    return UIColor(red: r + m, green: g + m, blue: b + m, alpha: 1)
}
