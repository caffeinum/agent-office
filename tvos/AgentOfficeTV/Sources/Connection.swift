import Foundation

/// An office link ("https://host/o/<id>#k=<key>") → the viewer WebSocket, with the key in a subprotocol like the web viewer.
struct OfficeLink: Equatable {
    let socketURL: URL
    let key: String

    init(_ raw: String) throws {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text), let host = url.host, url.scheme == "https" || url.scheme == "http" else {
            throw LinkError("not an office link: expected https://<host>/o/<office>#k=<key>")
        }
        let parts = url.path.split(separator: "/")
        guard parts.count >= 2, parts[0] == "o" else { throw LinkError("the link has no /o/<office> path") }
        guard let frag = url.fragment, frag.hasPrefix("k="), frag.count > 2 else { throw LinkError("the link has no #k=<key>: copy a view link from the office") }
        let scheme = url.scheme == "https" ? "wss" : "ws"
        let port = url.port.map { ":\($0)" } ?? ""
        guard let ws = URL(string: "\(scheme)://\(host)\(port)/o/\(parts[1])/ws") else { throw LinkError("could not build the socket URL") }
        socketURL = ws
        key = String(frag.dropFirst(2))
    }
}

struct LinkError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// Keeps one viewer socket open, reconnecting with backoff; every text frame goes to `onFrame`.
final class Connection {
    private let link: OfficeLink
    private let onFrame: (String) -> Void
    private let onState: (String) -> Void
    private var task: URLSessionWebSocketTask?
    private var pinger: Timer?
    private var backoff: TimeInterval = 1
    private var stopped = false

    init(link: OfficeLink, onFrame: @escaping (String) -> Void, onState: @escaping (String) -> Void) {
        self.link = link
        self.onFrame = onFrame
        self.onState = onState
    }

    func start() {
        stopped = false
        open()
    }

    func stop() {
        stopped = true
        pinger?.invalidate()
        task?.cancel(with: .goingAway, reason: nil)
    }

    private func open() {
        onState("connecting")
        var req = URLRequest(url: link.socketURL)
        req.setValue("agent-office, ao-key.\(link.key)", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let t = URLSession.shared.webSocketTask(with: req)
        task = t
        t.resume()
        receive(t)
        pinger?.invalidate()
        pinger = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak t] _ in
            t?.send(.string("{\"type\":\"ping\"}")) { _ in }
        }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self, t === self.task else { return }
            switch result {
            case .success(let msg):
                self.backoff = 1
                if case .string(let text) = msg { DispatchQueue.main.async { self.onFrame(text) } }
                self.receive(t)
            case .failure(let err):
                DispatchQueue.main.async { self.onState("offline: \(err.localizedDescription)") }
                self.retry()
            }
        }
    }

    private func retry() {
        guard !stopped else { return }
        let wait = backoff
        backoff = min(backoff * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self, !self.stopped else { return }
            self.open()
        }
    }
}
