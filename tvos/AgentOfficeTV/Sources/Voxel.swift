import SceneKit
import UIKit

/// voxel.js meshes and textures.js textures in SceneKit, built from the web viewer's own code through the bridge.
final class Voxel {
    private let bridge: Bridge
    private var textures: [String: UIImage] = [:]

    init(bridge: Bridge) { self.bridge = bridge }

    /// One merged mesh for a box list: vertex colours (linear, like three's), world-scaled UVs and baked AO.
    func geometry(_ boxes: [OfficeScene.Box], ao: Bool = true, floorY: Double = 0) throws -> SCNGeometry {
        try Self.geometry(bridge.mesh(boxes, ao: ao, floorY: floorY))
    }

    static func geometry(_ m: MeshData) -> SCNGeometry {
        let n = m.pos.count / 3
        precondition(m.nor.count == n * 3 && m.col.count == n * 3 && m.uv.count == n * 2, "voxel mesh attribute lengths disagree")
        let vec3 = { (a: [Float], semantic: SCNGeometrySource.Semantic) in
            SCNGeometrySource(data: a.withUnsafeBufferPointer { Data(buffer: $0) }, semantic: semantic, vectorCount: n, usesFloatComponents: true,
                              componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
        }
        // three's v grows upward; SceneKit's texture v grows downward (1 - v keeps 0…1 screen UVs inside the texture)
        let uv = stride(from: 0, to: m.uv.count, by: 2).flatMap { [m.uv[$0], 1 - m.uv[$0 + 1]] }
        let uvs = SCNGeometrySource(data: uv.withUnsafeBufferPointer { Data(buffer: $0) }, semantic: .texcoord, vectorCount: n, usesFloatComponents: true,
                                    componentsPerVector: 2, bytesPerComponent: 4, dataOffset: 0, dataStride: 8)
        let el = SCNGeometryElement(indices: m.idx, primitiveType: .triangles)
        return SCNGeometry(sources: [vec3(m.pos, .vertex), vec3(m.nor, .normal), vec3(m.col, .color), uvs], elements: [el])
    }

    /// A textures.js texture (cached), e.g. ("grain"), ("floor", "wood"), ("wall", "brick").
    func texture(_ name: String, _ arg: String? = nil) throws -> UIImage {
        let key = arg.map { "\(name):\($0)" } ?? name
        if let t = textures[key] { return t }
        let t = try bridge.texture(name, arg)
        guard t.rgb.count == t.w * t.h * 6 else { throw BridgeError.script("texture \(key): \(t.rgb.count) hex chars for \(t.w)×\(t.h)") }
        var bytes = [UInt8](repeating: 255, count: t.w * t.h * 4)
        var i = t.rgb.startIndex
        for p in 0..<(t.w * t.h) {
            for c in 0..<3 {
                let j = t.rgb.index(i, offsetBy: 2)
                bytes[p * 4 + c] = UInt8(t.rgb[i..<j], radix: 16)!
                i = j
            }
        }
        let provider = CGDataProvider(data: Data(bytes) as CFData)!
        let cg = CGImage(width: t.w, height: t.h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: t.w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                         bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false,
                         intent: .defaultIntent)!
        let img = UIImage(cgImage: cg)
        textures[key] = img
        return img
    }

    /// A lit material like the web's MeshStandardMaterial({vertexColors, map, roughness, metalness: 0}): physically
    /// based, texture × vertex colour × tint, chunky pixels.
    func material(map: UIImage?, tint: UIColor = .white, repeat r: CGSize? = nil, roughness: Double = 0.86) -> SCNMaterial {
        let m = SCNMaterial()
        // lambert: physically based rendered the same colours here but cost a third of the frame rate on the TV
        m.lightingModel = .lambert
        _ = roughness
        m.diffuse.contents = map ?? UIColor.white
        m.diffuse.wrapS = .repeat
        m.diffuse.wrapT = .repeat
        m.diffuse.magnificationFilter = .nearest
        m.diffuse.minificationFilter = .linear
        m.diffuse.mipFilter = .linear
        if let r { m.diffuse.contentsTransform = SCNMatrix4MakeScale(Float(r.width), Float(r.height), 1) }
        m.multiply.contents = tint
        return m
    }

    /// An unlit material (screens, windows, racks, lamp glow): texture × vertex colour × tint.
    func glow(map: UIImage?, tint: UIColor) -> SCNMaterial {
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = map ?? UIColor.white
        m.diffuse.magnificationFilter = .nearest
        m.multiply.contents = tint
        return m
    }
}
