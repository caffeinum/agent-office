import Foundation

struct OfficeScene: Decodable, Equatable {
    struct Grid: Decodable, Equatable { let w: Int; let d: Int }
    /// themeLook(): every colour and surface material the web scene paints with.
    struct Look: Decodable, Equatable {
        struct Floor: Decodable, Equatable { let material: String; let color: String; let roughness: Double }
        struct Accent: Decodable, Equatable { let material: String; let color: String; let wall: String }
        struct Walls: Decodable, Equatable { let color: String; let trim: String; let baseboard: String; let accent: Accent? }
        struct Desk: Decodable, Equatable { let wood: String; let rail: String }
        struct Mood: Decodable, Equatable { let sun, sky, ground, lamp, fill, nightSky: String }
        let floor: Floor
        let walls: Walls
        let desk: Desk
        let kindColors: [String: String]
        let mood: Mood
        let screenBg: String
        let nightWindow: String?
        /// Theme zones: floor rectangles whose room light is scaled by tint × (1 − dim).
        let zones: [Zone]
    }
    struct Zone: Decodable, Equatable { let x, z, w, d: Double; let tint: String; let dim: Double }
    /// model.js placedLights(): a custom kind's coloured point light, placed in the room.
    struct Light: Decodable, Equatable { let id: String; let x, y, z: Double; let color: String; let intensity, range: Double }
    /// model.js TIMES_OF_DAY for the local clock (or AO_TIME): three.js light levels.
    struct TimeOfDay: Decodable, Equatable {
        let name: String
        let hemiGround: String; let hemi: Double; let sun: Double; let sunColor: String; let fog: String
        let glow: Double; let lamp: Double; let point: Double; let neon: Double
        var night: Bool { name == "night" }
    }
    /// voxel.js box; `slope`/`lowFrac` make it a wedge (shape.js).
    struct Box: Codable, Equatable { let at: [Double]; let size: [Double]; let color: String?; let faces: [Int]?; let unitUV: Bool?; let slope: String?; let lowFrac: Double? }
    /// Boxes for voxel.js to merge, or (mesh roles) a custom kind's triangle meshes already built by voxel.js.
    struct Part: Decodable, Equatable { let role: String; let boxes: [Box]; let map: String?; let mesh: MeshData? }
    struct Kind: Decodable, Equatable { let defaultColor: String?; let glowColor: String?; let glowLamp: Bool; let parts: [Part] }
    struct Item: Decodable, Equatable { let id: String; let kind: String; let x: Double; let z: Double; let yaw: Double; let color: String? }
    struct Target: Decodable, Equatable { let key: String; let x: Double; let z: Double; let yaw: Double; let pose: String; let seatY: Double }
    struct RigPart: Decodable, Equatable { let parent: String?; let at: [Double]; let boxes: [Box]; let face: [Box]? }
    struct RigProp: Decodable, Equatable { let parent: String; let boxes: [Box] }
    struct Rig: Decodable, Equatable { let parts: [String: RigPart]; let props: [String: RigProp] }
    struct Agent: Decodable, Equatable {
        let id: String; let name: String; let emoji: String?; let status: String; let activity: String?
        let css: String; let phase: Double; let says: String?; let rig: Rig; let target: Target
    }
    struct Chat: Decodable, Equatable { let from: String; let to: String?; let text: String; let ts: Double }

    let id: String
    let name: String?
    let grid: Grid
    let wallH: Double
    let look: Look
    let time: TimeOfDay
    let kinds: [String: Kind]
    let items: [Item]
    let lights: [Light]
    let agents: [Agent]
    /// Each sitter's own monitor over its desk's screen glass; `key` changes when what it shows does.
    struct Screen: Decodable, Equatable {
        struct Spill: Decodable, Equatable { let x, z: Double; let color: String; let lit: Bool }
        let agent: String; let key: String; let x, y, z, yaw, w, h: Double; let spill: Spill
    }
    let screens: [Screen]
    let chat: [Chat]
}

/// limbAngles() output from the web viewer (radians; bob in units).
struct LimbAngles: Decodable {
    let legL, legR, armL, armR, armLz, armRz, head, headTilt, lean, bob: Double
    let seated: Bool
}

/// The room shell from room.js: garden slab border, garden boxes, the four walls (in their own frames) and the posts.
struct RoomPlan: Decodable {
    struct Wall: Decodable {
        let name: String; let surface: String; let len: Double; let doorAt: Double?; let at: [Double]; let yaw: Double
        let body, trim, stubBody, stubTrim: [OfficeScene.Box]
    }
    let border: Double
    let garden: [OfficeScene.Box]
    let walls: [Wall]
    let posts: [OfficeScene.Box]
    let backdrop: Backdrop
}

/// backdrop.js: the bay around the island (hills, downtown, bridge as one box list), the water, and drifting clouds.
struct Backdrop: Decodable {
    struct Water: Decodable { let x, z, size, y: Double; let color: String }
    struct Cloud: Decodable { let boxes: [OfficeScene.Box]; let x, y, z: Double }
    let land: [OfficeScene.Box]
    let windows: [OfficeScene.Box]
    let water: Water
    let clouds: [Cloud]
    let cloudSpeed: Double
    let cloudBand: Double

    /// cloudX(): a cloud's x at wall-clock seconds `t`, drifting along +x and wrapping round a band centred on `cx`.
    func cloudX(_ c: Cloud, cx: Double, t: Double) -> Double {
        var d = (c.x + t * cloudSpeed + cloudBand / 2).truncatingRemainder(dividingBy: cloudBand)
        if d < 0 { d += cloudBand }
        return cx + d - cloudBand / 2
    }
}

/// voxel.js buildGeometry output: positions, normals, linear vertex colours, world-scaled UVs, triangle indices.
struct MeshData: Decodable, Equatable { let pos, nor, col, uv: [Float]; let idx: [Int32] }

/// One textures.js texture: w × h pixels, 6 hex chars (rgb) each.
struct TextureData: Decodable { let w: Int; let h: Int; let rgb: String }
