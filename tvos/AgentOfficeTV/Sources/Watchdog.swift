import Foundation

/// Finds main-thread hangs on the device: code marks where it is with `Watchdog.at("…")`, a background thread checks
/// the main thread answers every 0.5 s, and when it hasn't for 2 s it prints the last mark (once per hang), which
/// `devicectl device process launch --console` shows.
enum Watchdog {
    /// stdout to a pipe is block-buffered; flush so the console sees each line as it happens
    private static func say(_ line: String) {
        print(line)
        fflush(stdout)
    }

    private static let lock = NSLock()
    private static var mark = "start"
    private static var beat = Date()

    static func at(_ m: String) {
        lock.lock(); mark = m; lock.unlock()
    }

    static func start() {
        say("AO_HANG watchdog on")
        Thread.detachNewThread {
            var reported = false
            while true {
                Thread.sleep(forTimeInterval: 0.5)
                DispatchQueue.main.async { lock.lock(); beat = Date(); lock.unlock() }
                lock.lock()
                let stale = Date().timeIntervalSince(beat), where_ = mark
                lock.unlock()
                if stale > 2, !reported {
                    say("AO_HANG main thread stuck \(String(format: "%.1f", stale))s at \(where_)")
                    reported = true
                } else if stale < 1, reported {
                    say("AO_HANG recovered")
                    reported = false
                }
            }
        }
    }
}
