import Foundation
import JavaScriptCore

/// The web viewer's own placement logic (office-bridge.js), run in JavaScriptCore.
final class Bridge {
    private let context: JSContext
    private let ao: JSValue

    init() throws {
        guard let url = Bundle.main.url(forResource: "office-bridge", withExtension: "js") else {
            throw BridgeError.missing("office-bridge.js is not in the app bundle (run tvos/build-bridge.sh)")
        }
        guard let ctx = JSContext() else { throw BridgeError.missing("JavaScriptCore would not start") }
        var thrown: String?
        ctx.exceptionHandler = { _, e in thrown = e?.toString() }
        ctx.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
        if let thrown { throw BridgeError.script("loading office-bridge.js: \(thrown)") }
        guard let ao = ctx.objectForKeyedSubscript("AO"), !ao.isUndefined else { throw BridgeError.missing("office-bridge.js did not define AO") }
        context = ctx
        self.ao = ao
    }

    /// Feeds one WebSocket frame; returns its type ("snapshot", "agent", …).
    func frame(_ text: String) throws -> String {
        try call("frame", [text]).toString()
    }

    /// The scene for this moment, or nil before the first snapshot.
    func scene(now: Date = Date()) throws -> OfficeScene? {
        let json = try call("scene", [now.timeIntervalSince1970 * 1000]).toString() ?? "null"
        return try JSONDecoder().decode(OfficeScene?.self, from: Data(json.utf8))
    }

    private func call(_ name: String, _ args: [Any]) throws -> JSValue {
        var thrown: String?
        context.exceptionHandler = { _, e in thrown = e?.toString() }
        let v = ao.invokeMethod(name, withArguments: args)
        if let thrown { throw BridgeError.script("AO.\(name): \(thrown)") }
        guard let v else { throw BridgeError.script("AO.\(name) returned nothing") }
        return v
    }
}

enum BridgeError: LocalizedError {
    case missing(String), script(String)
    var errorDescription: String? {
        switch self { case .missing(let m), .script(let m): return m }
    }
}
