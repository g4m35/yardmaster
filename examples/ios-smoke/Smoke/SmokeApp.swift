import SwiftUI

@main
struct SmokeApp: App {
    init() { SmokeMarker.write() }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Yardmaster smoke")
                .font(.title)
                .accessibilityIdentifier("smoke-title")
            Text("The app launched.")
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

enum SmokeMarker {
    /// The smoke test reads this file from the app's data container: proof that app code ran, not only that it installed.
    static func write() {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? "ready\n".write(to: documents.appendingPathComponent("smoke.txt"), atomically: true, encoding: .utf8)
        print("YM_SMOKE_READY")
    }
}
