import Foundation

struct OfficeScene: Decodable, Equatable {
    struct Grid: Decodable, Equatable { let w: Int; let d: Int }
    struct Theme: Decodable, Equatable {
        struct Floor: Decodable, Equatable { let color: String }
        struct Walls: Decodable, Equatable { let color: String; let trim: String }
        struct Desk: Decodable, Equatable { let wood: String; let rail: String }
        let floor: Floor
        let walls: Walls
        let desk: Desk
    }
    struct Box: Decodable, Equatable { let at: [Double]; let size: [Double]; let color: String? }
    struct Part: Decodable, Equatable { let role: String; let boxes: [Box] }
    struct Kind: Decodable, Equatable { let defaultColor: String?; let glowColor: String?; let parts: [Part] }
    struct Item: Decodable, Equatable { let id: String; let kind: String; let x: Double; let z: Double; let yaw: Double; let color: String? }
    struct Target: Decodable, Equatable { let key: String; let x: Double; let z: Double; let yaw: Double; let pose: String; let seatY: Double }
    struct Look: Decodable, Equatable { let skin: String; let hair: String; let pants: String; let style: String; let shirt: String; let shirtDark: String; let accent: String }
    struct Agent: Decodable, Equatable { let id: String; let name: String; let status: String; let activity: String?; let look: Look; let target: Target }
    struct Chat: Decodable, Equatable { let from: String; let to: String?; let text: String; let ts: Double }

    let id: String
    let name: String?
    let grid: Grid
    let wallH: Double
    let theme: Theme
    let kinds: [String: Kind]
    let items: [Item]
    let agents: [Agent]
    let chat: [Chat]
}
