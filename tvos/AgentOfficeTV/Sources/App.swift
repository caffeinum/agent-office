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
    @Published var sidebar = false
    let renderer = OfficeRenderer()
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
        connection = Connection(link: link, onFrame: { [weak self] in self?.receive($0) }, onState: { [weak self] in self?.status = $0 })
        connection?.start()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stop() {
        connection?.stop()
        timer?.invalidate()
        renderer.detach()
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
            SceneView(renderer: model.renderer, playPause: { model.sidebar.toggle() }, holdSelect: forget).ignoresSafeArea()
            if model.sidebar {
                Sidebar(title: model.title, status: model.status, agents: model.agents, chat: model.chat)
            } else {
                HStack(spacing: 10) {
                    Image(systemName: "line.3.horizontal")
                    Text("\(model.agents.count)").font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 2)
                        .background(Capsule().fill(Color(red: 0.94, green: 0.36, blue: 0.27))).foregroundStyle(.white)
                }
                .padding(.horizontal, 22).padding(.vertical, 14)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22))
                .padding(48)
            }
            if let f = model.failure {
                Text(f).font(.caption).foregroundStyle(.red).padding(48).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
        .onAppear { model.start(link) }
        .onDisappear { model.stop() }
    }
}

/// The web sidebar: office name, live state, who is here with their status, and the latest chat.
struct Sidebar: View {
    let title: String
    let status: String
    let agents: [OfficeScene.Agent]
    let chat: [OfficeScene.Chat]
    private static let dot: [String: Color] = ["working": Color(red: 0.31, green: 0.75, blue: 0.48), "idle": Color(red: 0.56, green: 0.65, blue: 0.79),
                                               "waiting": Color(red: 0.95, green: 0.70, blue: 0.24), "away": Color(red: 0.71, green: 0.67, blue: 0.64)]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline)
                Spacer()
                Text(status).font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(agents, id: \.id) { a in
                HStack(spacing: 14) {
                    Text(a.emoji ?? String(a.name.prefix(1)).uppercased()).font(.callout.bold()).foregroundStyle(.white)
                        .frame(width: 44, height: 44).background(RoundedRectangle(cornerRadius: 12).fill(Color(uiColor: cssColor(a.css))))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(a.name).font(.caption.bold()).lineLimit(1)
                        Text(a.status == "working" ? (a.activity ?? "working") : a.status == "waiting" ? (a.activity ?? "needs input") : a.status)
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Circle().fill(Self.dot[a.status] ?? .gray).frame(width: 14, height: 14)
                }
            }
            if !chat.isEmpty {
                Divider()
                ForEach(chat.suffix(5), id: \.ts) { m in
                    (Text(m.from).bold() + Text(m.to.map { " → \($0)" } ?? "") + Text(": \(m.text)")).font(.caption2).lineLimit(3)
                }
            }
            Text("swipe: orbit / tilt · circle the ring: zoom · ◀ ▶ follow · ▲ reset · play/pause: this list").font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(28)
        .frame(width: 560, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 28))
        .padding(48)
    }
}

struct SceneView: UIViewRepresentable {
    let renderer: OfficeRenderer
    let playPause: () -> Void
    let holdSelect: () -> Void
    func makeUIView(context: Context) -> OfficeSCNView {
        let v = OfficeSCNView()
        v.antialiasingMode = .multisampling4X
        v.backgroundColor = .clear
        v.isPlaying = true
        v.onPlayPause = playPause
        v.onHoldSelect = holdSelect
        renderer.attach(v)
        return v
    }
    func updateUIView(_ v: OfficeSCNView, context: Context) {
        v.onPlayPause = playPause
        v.onHoldSelect = holdSelect
    }
}
