import SwiftUI

/// Host app for the UI test bundle. XCUITest needs one; the tests drive another app by bundle ID.
@main
struct YardRunnerApp: App {
    var body: some Scene {
        WindowGroup { Text("Yardmaster device runner").padding() }
    }
}
