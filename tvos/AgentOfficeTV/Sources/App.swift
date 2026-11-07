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
    /// The controls strip: shown for a while after launch and after ▲ (home), hidden on other input.
    @Published var hints = true
    private var hintsUntil = Date().addingTimeInterval(14)
    /// The highlighted row while the agent list is open.
    @Published var cursor = 0
    let renderer = OfficeRenderer()
    private var exitHintUntil: Date = .distantPast

    enum Panel: Equatable { case none, agents, chat(agent: String?) }
    private var bridge: Bridge?
    private var sound: SoundPlayer?
    private let radio = RadioPlayer()
    @Published var toast: String?
    private var toastWork: DispatchWorkItem?
    private var connection: Connection?
    private var link: OfficeLink?
    private var timer: Timer?
    private var bridgeTimer: Timer?

    func start(_ link: OfficeLink) {
        Watchdog.start()
        // sound is part of the ambience: on, unless AO_SOUND=0; a TV without audio out just stays quiet
        if ProcessInfo.processInfo.environment["AO_SOUND"] != "0" {
            do { sound = try SoundPlayer() } catch { print("AO_SOUND off: \(error)") }
        }
        // a live office is meant to be left on screen, like a fish tank: no screensaver while the app is open
        UIApplication.shared.isIdleTimerDisabled = true
        showHints(14)
        do {
            bridge = try Bridge()
        } catch {
            failure = error.localizedDescription
            return
        }
        renderer.bridge = bridge
        if let id = UserDefaults.standard.string(forKey: "radio") {
            do { radio.play(try stationNamed(id)) } catch { failure = error.localizedDescription }
        }
        renderer.onFollow = { [weak self] id in
            guard let self else { return }
            following = id
            if let id, let i = agents.firstIndex(where: { $0.id == id }) { cursor = i }
            if case .chat(let a?) = panel, a != id { panel = id.map { .chat(agent: $0) } ?? .none }
        }
        self.link = link
        connect()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
        checkBridge()
        bridgeTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in self?.checkBridge() }
    }

    /// The logo the office shows now (fetched or being fetched).
    private var logoWanted: OfficeScene.Logo?

    /// scene.js syncLogo: fetches the office logo (asset URLs need no key) and hands it to the renderer; a failed fetch
    /// leaves the plain screens and says so.
    private func fetchLogo(_ logo: OfficeScene.Logo?, screenBg: String) {
        logoWanted = logo
        guard let logo else { renderer.setLogo(nil, id: nil, screenBg: screenBg); return }
        guard let base = link?.bridgeURL, let url = URL(string: logo.url, relativeTo: base) else { failure = "bad logo URL \(logo.url)"; return }
        URLSession.shared.dataTask(with: url) { [weak self] data, resp, error in
            DispatchQueue.main.async {
                guard let self, self.logoWanted == logo else { return }
                guard error == nil, (resp as? HTTPURLResponse)?.statusCode == 200, let data, let img = UIImage(data: data) else {
                    print("office logo: couldn't load \(url.absoluteString): \(error?.localizedDescription ?? "status \((resp as? HTTPURLResponse)?.statusCode ?? 0)")")
                    return
                }
                self.renderer.setLogo(img, id: logo.id, screenBg: screenBg)
            }
        }.resume()
    }

    /// Bumped on every (re)connect: frames the old socket had already queued are dropped, so after a bridge swap the
    /// fresh bridge only ever sees the new socket's snapshot first ("frame chat arrived before the snapshot" otherwise).
    private var connectionGen = 0

    private func connect() {
        guard let link else { return }
        connection?.stop()
        connectionGen += 1
        let gen = connectionGen
        connection = Connection(link: link, onFrame: { [weak self] text in
            guard let self, gen == self.connectionGen else { return }
            self.receive(text)
        }, onState: { [weak self] st in
            guard let self, gen == self.connectionGen else { return }
            self.status = st
        })
        connection?.start()
    }

    /// Fetches the office site's office-bridge.js; a new one that loads replaces the running behaviour (placement, poses,
    /// light, screens) without an app update, and a fresh snapshot fills it in. A failed fetch or a bad bundle keeps the
    /// running one (logged): the office keeps working on what it has.
    private func checkBridge() {
        guard let url = link?.bridgeURL else { return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.setValue("AgentOfficeTV", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, error in
            DispatchQueue.main.async {
                guard let self, let bridge = self.bridge else { return }
                guard error == nil, (resp as? HTTPURLResponse)?.statusCode == 200, let data, let code = String(data: data, encoding: .utf8) else {
                    print("bridge update: fetch failed (\(error?.localizedDescription ?? "status \((resp as? HTTPURLResponse)?.statusCode ?? 0)"))")
                    return
                }
                guard code != bridge.source else { return }
                do {
                    try bridge.reload(code)
                } catch {
                    print("bridge update: kept the running bundle: \(error.localizedDescription)")
                    return
                }
                print("bridge update: loaded \(data.count) bytes from \(url.host ?? "")")
                self.renderer.bridge = bridge
                self.connect()
            }
        }.resume()
    }

    func stop() {
        connection?.stop()
        timer?.invalidate()
        bridgeTimer?.invalidate()
        renderer.detach()
    }

    /// The remote: ◀ ▶ step through agents, select follows, ▲ goes home, ▼ toggles the room chat, play/pause toggles the
    /// agent list (or the followed agent's chat), back closes things one at a time and then exits on a second press.
    func press(_ type: UIPress.PressType) {
        Watchdog.at("press \(type.rawValue)")
        defer { Watchdog.at("idle") }
        renderer.noteInput()
        showHints(type == .upArrow ? 8 : 0)
        if panel == .agents, !agents.isEmpty, [.upArrow, .downArrow, .select].contains(type) {
            switch type {
            case .upArrow: cursor = max(0, cursor - 1)
            case .downArrow: cursor = min(agents.count - 1, cursor + 1)
            default:
                renderer.follow(agents[cursor].id)
                panel = .chat(agent: agents[cursor].id)
            }
            exitHint = false
            return
        }
        switch type {
        case .leftArrow: renderer.step(-1)
        case .rightArrow: renderer.step(1)
        case .select: renderer.toggleFollow()
        case .upArrow: renderer.home()
        case .downArrow: panel = panel == .chat(agent: nil) ? .none : .chat(agent: nil)
        case .playPause:
            let want: Panel = following.map { .chat(agent: $0) } ?? .agents
            panel = panel == want ? .none : want
            if panel == .agents { cursor = following.flatMap { id in agents.firstIndex { $0.id == id } } ?? 0 }
        case .menu:
            if clean { clean = false; renderer.bubblesOnly = false }
            else if case .chat(_?) = panel { panel = .chat(agent: nil) }
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
                if name == "radio" { self?.nextRadio(); return }
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

    private func showHints(_ seconds: Double) {
        hintsUntil = Date().addingTimeInterval(seconds)
        hints = seconds > 0
        guard seconds > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            if let self, Date() >= self.hintsUntil { self.hints = false }
        }
    }

    func toggleClean() {
        renderer.noteInput()
        clean.toggle()
        renderer.bubblesOnly = clean
    }

    private func receive(_ text: String) {
        Watchdog.at("frame")
        defer { Watchdog.at("idle") }
        do {
            let type = try bridge?.frame(text)
            if type == "snapshot" { status = "live" }
            refresh()
            if let cues = try bridge?.cues(), !cues.isEmpty {
                if ProcessInfo.processInfo.environment["AO_STATS"] != nil { print("AO_SOUND \(cues.map(\.sound).joined(separator: " "))") }
                sound?.play(cues, pan: renderer.soundPan)
            }
        } catch {
            failure = error.localizedDescription
        }
    }

    /// Hold ▲: off → first station → … → off (radio.js), remembered.
    func nextRadio() {
        do {
            let s = try bridge?.nextStation(after: radio.station?.id)
            radio.play(s)
            UserDefaults.standard.set(s?.id, forKey: "radio")
            show(s.map { "📻 \($0.name)" } ?? "📻 radio off")
        } catch {
            failure = error.localizedDescription
        }
    }

    /// The saved station, found by walking radio.js's list.
    private func stationNamed(_ id: String) throws -> RadioStation? {
        var s = try bridge?.nextStation(after: nil)
        while let c = s, c.id != id { s = try bridge?.nextStation(after: c.id) }
        return s
    }

    private func show(_ text: String) {
        toast = text
        toastWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.toast = nil }
        toastWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: w)
    }

    private func refresh() {
        Watchdog.at("refresh.scene")
        defer { Watchdog.at("idle") }
        do {
            guard let s = try bridge?.scene() else { return }
            renderer.apply(s)
            if s.logo != logoWanted { fetchLogo(s.logo, screenBg: s.look.screenBg) }
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
                    AgentsPanel(title: model.title, status: model.status, agents: model.agents, following: model.following, cursor: model.cursor)
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
            if model.hints && !model.clean && model.panel == .none && !model.exitHint {
                Text("touch ↔ turn · touch ↕ zoom · tap tap + drag slide · ◀ ▶ follow · ⏯ agents · ▼ chat · ▲ home · hold ▲ radio · hold ⏯ hide")
                    .font(.caption2).foregroundStyle(Color(red: 0.17, green: 0.14, blue: 0.13))
                    .padding(.horizontal, 26).padding(.vertical, 12)
                    .background(Capsule().fill(Color(red: 1, green: 0.99, blue: 0.97, opacity: 0.92)))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom).padding(.bottom, 60)
            }
            if let t = model.toast {
                Text(t).font(.callout).padding(.horizontal, 28).padding(.vertical, 14)
                    .background(.ultraThinMaterial, in: Capsule())
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).padding(.top, 60)
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

private let statusDot: [String: Color] = ["working": Color(red: 0.31, green: 0.75, blue: 0.48), "running": Color(red: 0.25, green: 0.65, blue: 0.72), "idle": Color(red: 0.56, green: 0.65, blue: 0.79),
                                          "waiting": Color(red: 0.95, green: 0.70, blue: 0.24), "away": Color(red: 0.71, green: 0.67, blue: 0.64)]

/// The web sidebar's roster: office name, live state, who is here with their status. ▲▼ move the highlight (the list
/// scrolls to keep it in view), select follows the highlighted agent; the followed one is outlined in its colour.
struct AgentsPanel: View {
    let title: String
    let status: String
    let agents: [OfficeScene.Agent]
    let following: String?
    let cursor: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline)
                Text("\(agents.count) here · \(status)").font(.caption2).foregroundStyle(.secondary)
            }
            ScrollViewReader { scroll in
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(agents.enumerated()), id: \.element.id) { i, a in row(a, highlighted: i == cursor).id(a.id) }
                    }
                }
                .onChange(of: cursor) { _, c in
                    guard agents.indices.contains(c) else { return }
                    withAnimation(.easeOut(duration: 0.2)) { scroll.scrollTo(agents[c].id, anchor: .center) }
                }
                .onAppear { if agents.indices.contains(cursor) { scroll.scrollTo(agents[cursor].id, anchor: .center) } }
            }
            Text("▲▼ choose · select follow · ⏯ close · ◀ ▶ next agent").font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(28)
        .frame(width: 560, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 28).fill(Color(red: 1, green: 0.99, blue: 0.97, opacity: 0.95)))
        .padding(48)
    }

    private func row(_ a: OfficeScene.Agent, highlighted: Bool) -> some View {
        HStack(spacing: 12) {
            Text(a.emoji ?? String(a.name.prefix(1)).uppercased()).font(.caption.bold()).foregroundStyle(.white)
                .frame(width: 40, height: 40).background(RoundedRectangle(cornerRadius: 10).fill(Color(uiColor: cssColor(a.css))))
            VStack(alignment: .leading, spacing: 0) {
                Text(a.name).font(.caption.bold()).lineLimit(1)
                Text(a.status == "working" || a.status == "running" ? (a.activity ?? a.status) : a.status == "waiting" ? (a.activity ?? "needs input") : a.status)
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Circle().fill(statusDot[a.status] ?? .gray).frame(width: 12, height: 12)
        }
        .frame(height: 52)
        .padding(.horizontal, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(highlighted ? Color(uiColor: cssColor(a.css)).opacity(0.22) : .clear))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(uiColor: cssColor(a.css)), lineWidth: following == a.id ? 3 : 0))
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
        v.onHoldUp = { [model] in model.nextRadio() }
        v.onHoldSelect = holdSelect
    }
}
