import SceneKit
import SwiftUI

@main
struct AgentOfficeTVApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

/// The saved office link (a view link is enough); AO_LINK in the launch environment overrides it for testing.
final class Settings: ObservableObject {
    @Published var link: String? {
        didSet { UserDefaults.standard.set(link, forKey: "officeLink") }
    }
    init() {
        if let given = ProcessInfo.processInfo.environment["AO_LINK"] { UserDefaults.standard.set(given, forKey: "officeLink") }
        link = UserDefaults.standard.string(forKey: "officeLink")
    }
}

struct RootView: View {
    @StateObject private var settings = Settings()
    var body: some View {
        if let raw = settings.link, let link = try? OfficeLink(raw) {
            OfficeScreen(link: link, forget: { settings.link = nil })
        } else {
            LinkEntry(saved: settings.link) { settings.link = $0 }
        }
    }
}

struct LinkEntry: View {
    let saved: String?
    let save: (String) -> Void
    @State private var text = ""
    @State private var error: String?

    var body: some View {
        VStack(spacing: 36) {
            Text("Agent Office").font(.largeTitle).bold()
            Text("Paste the office's view link (https://…/o/<office>#k=<key>). Typing it with an iPhone keyboard is easiest.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 1100)
            TextField("https://office.example.com/o/…#k=…", text: $text).frame(maxWidth: 1300)
                .onSubmit(connect)
            Button("Show office", action: connect)
            if let error { Text(error).foregroundStyle(.red) }
        }
        .padding(80)
        .onAppear { text = saved ?? "" }
    }

    private func connect() {
        do {
            _ = try OfficeLink(text)
            save(text.trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The live office: socket → bridge → renderer, refreshed once a second so idle agents wander on the shared clock.
final class OfficeModel: ObservableObject {
    @Published var status = "connecting"
    @Published var title = ""
    @Published var agents: [OfficeScene.Agent] = []
    @Published var chat: [OfficeScene.Chat] = []
    @Published var failure: String?
    @Published var panel: Panel = .none
    @Published var following: String?
    @Published var clean = false
    @Published var exitHint = false
    let renderer = OfficeRenderer()
    private var exitHintUntil: Date = .distantPast

    enum Panel: Equatable { case none, agents, chat(agent: String?) }
    private var bridge: Bridge?
    private var connection: Connection?
    private var timer: Timer?

    func start(_ link: OfficeLink) {
        do {
            bridge = try Bridge()
        } catch {
            failure = error.localizedDescription
            return
        }
        renderer.bridge = bridge
        renderer.onFollow = { [weak self] id in
            guard let self else { return }
            following = id
            if case .chat(let a?) = panel, a != id { panel = id.map { .chat(agent: $0) } ?? .none }
        }
        connection = Connection(link: link, onFrame: { [weak self] in self?.receive($0) }, onState: { [weak self] in self?.status = $0 })
        connection?.start()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stop() {
        connection?.stop()
        timer?.invalidate()
        renderer.detach()
    }

    /// The remote: ◀ ▶ step through agents, select follows, ▲ goes home, ▼ toggles the room chat, play/pause toggles the
    /// agent list (or the followed agent's chat), back closes things one at a time and then exits on a second press.
    func press(_ type: UIPress.PressType) {
        renderer.noteInput()
        switch type {
        case .leftArrow: renderer.step(-1)
        case .rightArrow: renderer.step(1)
        case .select: renderer.toggleFollow()
        case .upArrow: renderer.home()
        case .downArrow: panel = panel == .chat(agent: nil) ? .none : .chat(agent: nil)
        case .playPause:
            let want: Panel = following.map { .chat(agent: $0) } ?? .agents
            panel = panel == want ? .none : want
        case .menu:
            if clean { clean = false }
            else if panel != .none { panel = .none }
            else if following != nil { renderer.unfollow() }
            else {
                exitHintUntil = Date().addingTimeInterval(2.5)
                exitHint = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                    if let self, Date() >= self.exitHintUntil { self.exitHint = false }
                }
            }
        default: break
        }
        if type != .menu { exitHint = false; exitHintUntil = .distantPast }
    }

    /// Test hook: AO_PRESSES="right+playPause+…" replays remote presses one per AO_PRESS_GAP seconds (default 2), starting
    /// 8 s after launch, so the simulator can be driven headless.
    func replayPresses() {
        let env = ProcessInfo.processInfo.environment
        guard let list = env["AO_PRESSES"] else { return }
        let gap = Double(env["AO_PRESS_GAP"] ?? "2") ?? 2
        let names: [String: UIPress.PressType] = ["up": .upArrow, "down": .downArrow, "left": .leftArrow, "right": .rightArrow,
                                                  "select": .select, "playPause": .playPause, "menu": .menu]
        for (i, name) in list.split(separator: "+").enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 8 + Double(i) * gap) { [weak self] in
                if name == "hold" { self?.toggleClean(); return }
                guard let t = names[String(name)] else { preconditionFailure("AO_PRESSES: unknown press \(name)") }
                if t == .menu && self?.consumesMenu() == false { print("AO_PRESSES: back would exit the app now"); return }
                self?.press(t)
            }
        }
    }

    /// Back is ours unless the exit hint is up: then it goes to the system, which leaves the app.
    func consumesMenu() -> Bool {
        clean || panel != .none || following != nil || Date() >= exitHintUntil
    }

    func toggleClean() {
        renderer.noteInput()
        clean.toggle()
    }

    private func receive(_ text: String) {
        do {
            let type = try bridge?.frame(text)
            if type == "snapshot" { status = "live" }
            refresh()
        } catch {
            failure = error.localizedDescription
        }
    }

    private func refresh() {
        do {
            guard let s = try bridge?.scene() else { return }
            renderer.apply(s)
            title = s.name ?? s.id
            agents = s.agents
            chat = s.chat
        } catch {
            failure = error.localizedDescription
        }
    }
}

struct OfficeScreen: View {
    let link: OfficeLink
    let forget: () -> Void
    @StateObject private var model = OfficeModel()

    var body: some View {
        ZStack(alignment: .topLeading) {
            SceneView(renderer: model.renderer, model: model, holdSelect: forget).ignoresSafeArea()
            if !model.clean {
                switch model.panel {
                case .agents:
                    AgentsPanel(title: model.title, status: model.status, agents: model.agents, following: model.following)
                case .chat(let id):
                    ChatPanel(agent: id.flatMap { id in model.agents.first { $0.id == id } }, chat: model.chat)
                case .none:
                    HStack(spacing: 10) {
                        Image(systemName: "line.3.horizontal")
                        Text("\(model.agents.count)").font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 2)
                            .background(Capsule().fill(Color(red: 0.94, green: 0.36, blue: 0.27))).foregroundStyle(.white)
                    }
                    .padding(.horizontal, 22).padding(.vertical, 14)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22))
                    .padding(48)
                }
            }
            if model.exitHint {
                Text("press back again to exit").font(.callout).padding(.horizontal, 28).padding(.vertical, 14)
                    .background(.ultraThinMaterial, in: Capsule())
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom).padding(.bottom, 80)
            }
            if let f = model.failure {
                Text(f).font(.caption).foregroundStyle(.red).padding(48).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
        .environment(\.colorScheme, .light)
        .onAppear { model.start(link); model.replayPresses() }
        .onDisappear { model.stop() }
    }
}

private let statusDot: [String: Color] = ["working": Color(red: 0.31, green: 0.75, blue: 0.48), "idle": Color(red: 0.56, green: 0.65, blue: 0.79),
                                          "waiting": Color(red: 0.95, green: 0.70, blue: 0.24), "away": Color(red: 0.71, green: 0.67, blue: 0.64)]

/// The web sidebar's roster: office name, live state, who is here with their status. The followed agent is marked.
/// It always fits the screen: rows flow into as many columns as the height needs (the remote can't scroll it).
struct AgentsPanel: View {
    let title: String
    let status: String
    let agents: [OfficeScene.Agent]
    let following: String?
    private static let rowH: CGFloat = 58, colW: CGFloat = 420

    var body: some View {
        GeometryReader { geo in
            let perCol = max(1, Int((geo.size.height - 96 - 160) / Self.rowH))
            let cols = stride(from: 0, to: agents.count, by: perCol).map { Array(agents[$0..<min($0 + perCol, agents.count)]) }
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.headline)
                    Text("\(agents.count) here · \(status)").font(.caption2).foregroundStyle(.secondary)
                }
                HStack(alignment: .top, spacing: 24) {
                    ForEach(Array(cols.enumerated()), id: \.offset) { _, col in
                        VStack(alignment: .leading, spacing: 4) { ForEach(col, id: \.id) { row($0) } }.frame(width: Self.colW)
                    }
                }
                Text("◀ ▶ follow · ⏯ list · ▼ chat · ▲ home · ring: spin · swipe ↕ zoom ↔ pan").font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(28)
            .background(RoundedRectangle(cornerRadius: 28).fill(Color(red: 1, green: 0.99, blue: 0.97, opacity: 0.95)))
            .padding(48)
        }
    }

    private func row(_ a: OfficeScene.Agent) -> some View {
        HStack(spacing: 12) {
            Text(a.emoji ?? String(a.name.prefix(1)).uppercased()).font(.caption.bold()).foregroundStyle(.white)
                .frame(width: 40, height: 40).background(RoundedRectangle(cornerRadius: 10).fill(Color(uiColor: cssColor(a.css))))
            VStack(alignment: .leading, spacing: 0) {
                Text(a.name).font(.caption.bold()).lineLimit(1)
                Text(a.status == "working" ? (a.activity ?? "working") : a.status == "waiting" ? (a.activity ?? "needs input") : a.status)
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Circle().fill(statusDot[a.status] ?? .gray).frame(width: 12, height: 12)
        }
        .frame(height: Self.rowH - 6)
        .padding(.horizontal, 6)
        .background(RoundedRectangle(cornerRadius: 12).stroke(Color(uiColor: cssColor(a.css)), lineWidth: following == a.id ? 3 : 0))
    }
}

/// The room chat, or one agent's conversation (what it said and what was said to it) while it is followed.
struct ChatPanel: View {
    let agent: OfficeScene.Agent?
    let chat: [OfficeScene.Chat]
    var body: some View {
        let lines = agent.map { a in chat.filter { $0.from == a.name || $0.to == a.name } } ?? chat
        VStack(alignment: .leading, spacing: 14) {
            Text(agent.map { "\($0.emoji.map { "\($0) " } ?? "")\($0.name)" } ?? "room chat").font(.headline)
            if lines.isEmpty { Text("nothing yet").font(.caption2).foregroundStyle(.secondary) }
            ForEach(Array(lines.suffix(10).enumerated()), id: \.offset) { _, m in
                (Text(m.from).bold() + Text(m.to.map { " → \($0)" } ?? "") + Text(": \(m.text)")).font(.caption2).lineLimit(4)
            }
        }
        .padding(28)
        .frame(width: 620, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 28).fill(Color(red: 1, green: 0.99, blue: 0.97, opacity: 0.95)))
        .padding(48)
    }
}

struct SceneView: UIViewRepresentable {
    let renderer: OfficeRenderer
    let model: OfficeModel
    let holdSelect: () -> Void
    func makeUIView(context: Context) -> OfficeSCNView {
        let v = OfficeSCNView()
        v.antialiasingMode = .multisampling4X
        v.backgroundColor = .clear
        v.isPlaying = true
        v.showsStatistics = ProcessInfo.processInfo.environment["AO_STATS"] != nil
        wire(v)
        renderer.attach(v)
        return v
    }
    func updateUIView(_ v: OfficeSCNView, context: Context) { wire(v) }
    private func wire(_ v: OfficeSCNView) {
        v.onPress = { [model] in model.press($0) }
        v.consumesMenu = { [model] in model.consumesMenu() }
        v.onHoldPlayPause = { [model] in model.toggleClean() }
        v.onHoldSelect = holdSelect
    }
}
