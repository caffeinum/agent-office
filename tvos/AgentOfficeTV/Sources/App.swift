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
    @Published var chat: [OfficeScene.Chat] = []
    @Published var failure: String?
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
        connection = Connection(link: link, onFrame: { [weak self] in self?.receive($0) }, onState: { [weak self] in self?.status = $0 })
        connection?.start()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stop() {
        connection?.stop()
        timer?.invalidate()
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
        ZStack(alignment: .bottomLeading) {
            SceneView(renderer: model.renderer).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(model.title).font(.headline)
                    Text(model.status).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(model.chat.suffix(3), id: \.ts) { m in
                    Text("\(m.from): \(m.text)").font(.caption).lineLimit(2)
                }
                if let f = model.failure { Text(f).foregroundStyle(.red).font(.callout) }
            }
            .padding(24)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
            .padding(48)
            .frame(maxWidth: 760, alignment: .leading)
        }
        .onAppear { model.start(link) }
        .onDisappear { model.stop() }
        .onMoveCommand { dir in
            switch dir {
            case .left: model.renderer.turn(by: -0.25)
            case .right: model.renderer.turn(by: 0.25)
            default: break
            }
        }
        .onPlayPauseCommand(perform: forget)
    }
}

struct SceneView: UIViewRepresentable {
    let renderer: OfficeRenderer
    func makeUIView(context: Context) -> SCNView {
        let v = SCNView()
        v.scene = renderer.scene
        v.pointOfView = renderer.camera
        v.delegate = renderer
        v.isPlaying = true
        v.antialiasingMode = .multisampling4X
        v.backgroundColor = .clear
        return v
    }
    func updateUIView(_ v: SCNView, context: Context) {}
}
