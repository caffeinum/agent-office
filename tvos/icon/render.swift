// Renders back.svg / front.svg into the tvOS "App Icon & Top Shelf Image" brand assets: a two-layer app icon (400x240
// @1x/@2x for the home screen, 1280x768 for the App Store) and the top shelf images (1920x720, 2320x720, @1x/@2x).
// usage: swift render.swift <icon dir> <Assets.xcassets dir>
import AppKit

let args = CommandLine.arguments
let iconDir = URL(fileURLWithPath: args[1]), assets = URL(fileURLWithPath: args[2])
let fm = FileManager.default

func load(_ name: String) -> NSImage {
    guard let img = NSImage(contentsOf: iconDir.appendingPathComponent(name)) else { fatalError("can't load \(name)") }
    return img
}
let back = load("back.svg"), front = load("front.svg")

/// Draws layers into a w×h PNG. `fit` scales the 1280x768 art to the height and centres it (top shelf is wider).
func png(_ layers: [NSImage], _ w: Int, _ h: Int, opaque: Bool, to url: URL) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                               isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    for (i, l) in layers.enumerated() {
        if i == 0 && opaque && w * 768 != h * 1280 {
            l.draw(in: NSRect(x: 0, y: 0, width: w, height: h))  // the sky stretches to any width
            continue
        }
        let s = CGFloat(h) / 768, dw = 1280 * s
        l.draw(in: NSRect(x: (CGFloat(w) - dw) / 2, y: 0, width: dw, height: CGFloat(h)))
    }
    NSGraphicsContext.restoreGraphicsState()
    var data = rep.representation(using: .png, properties: [:])!
    if opaque {  // strip alpha: app icon back layers and top shelf images must be opaque
        let src = CGImageSourceCreateWithData(data as CFData, nil)!, cg = CGImageSourceCreateImageAtIndex(src, 0, nil)!
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        data = NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
    }
    try! fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try! data.write(to: url)
}

func json(_ obj: Any, _ url: URL) {
    try! fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try! JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]).write(to: url)
}
let info = ["author": "xcode", "version": 1] as [String: Any]

let brand = assets.appendingPathComponent("App Icon & Top Shelf Image.brandassets")
try? fm.removeItem(at: brand)
json(["info": info], assets.appendingPathComponent("Contents.json"))

func stack(_ name: String, w: Int, h: Int, scales: [Int]) {
    let dir = brand.appendingPathComponent("\(name).imagestack")
    json(["info": info, "layers": [["filename": "Front.imagestacklayer"], ["filename": "Back.imagestacklayer"]]], dir.appendingPathComponent("Contents.json"))
    for (layer, imgs, opaque) in [("Front", [front], false), ("Back", [back], true)] {
        let l = dir.appendingPathComponent("\(layer).imagestacklayer")
        json(["info": info], l.appendingPathComponent("Contents.json"))
        let set = l.appendingPathComponent("Content.imageset")
        var images: [[String: String]] = []
        for s in scales {
            let file = "\(layer.lowercased())@\(s)x.png"
            png(imgs, w * s, h * s, opaque: opaque, to: set.appendingPathComponent(file))
            images.append(["idiom": "tv", "filename": file, "scale": "\(s)x"])
        }
        json(["info": info, "images": images], set.appendingPathComponent("Contents.json"))
    }
}
stack("App Icon", w: 400, h: 240, scales: [1, 2])
stack("App Icon - App Store", w: 1280, h: 768, scales: [1])

func shelf(_ name: String, w: Int, h: Int) {
    let set = brand.appendingPathComponent("\(name).imageset")
    var images: [[String: String]] = []
    for s in [1, 2] {
        let file = "shelf@\(s)x.png"
        png([back, front], w * s, h * s, opaque: true, to: set.appendingPathComponent(file))
        images.append(["idiom": "tv", "filename": file, "scale": "\(s)x"])
    }
    json(["info": info, "images": images], set.appendingPathComponent("Contents.json"))
}
shelf("Top Shelf Image", w: 1920, h: 720)
shelf("Top Shelf Image Wide", w: 2320, h: 720)

json(["info": info, "assets": [
    ["filename": "App Icon - App Store.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "1280x768"],
    ["filename": "App Icon.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "400x240"],
    ["filename": "Top Shelf Image Wide.imageset", "idiom": "tv", "role": "top-shelf-image-wide", "size": "2320x720"],
    ["filename": "Top Shelf Image.imageset", "idiom": "tv", "role": "top-shelf-image", "size": "1920x720"],
]], brand.appendingPathComponent("Contents.json"))
print("wrote \(brand.path)")
