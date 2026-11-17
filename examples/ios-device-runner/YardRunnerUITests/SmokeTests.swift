import XCTest

/// Drives an app that is already installed, by bundle ID, through a short list of steps. Inputs arrive as
/// environment variables (xcodebuild passes `TEST_RUNNER_<NAME>` to the test as `<NAME>`):
///   YM_TARGET_BUNDLE_ID  the app to drive
///   YM_STEPS             steps separated by U+001F; each is `verb` or `verb:argument`
/// Verbs: tap:<label>, expect:<text>, alert:<button>, home, banner:<text>, screenshot:<name>, wait:<seconds>.
/// Every screenshot is a test attachment; `scripts/run.sh` exports them into the evidence folder.
final class SmokeTests: XCTestCase {
    private let timeout: TimeInterval = 20

    func testSmoke() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        let bundleId = try XCTUnwrap(env["YM_TARGET_BUNDLE_ID"].flatMap { $0.isEmpty ? nil : $0 }, "YM_TARGET_BUNDLE_ID is not set")
        let app = XCUIApplication(bundleIdentifier: bundleId)
        // activate() brings a running app forward without relaunching it; launch() would restart it.
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "\(bundleId) did not reach the foreground")
        attach(XCUIScreen.main.screenshot(), "foreground")
        let steps = (env["YM_STEPS"] ?? "").split(separator: "\u{1F}").map(String.init).filter { !$0.isEmpty }
        for step in steps {
            let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
            let verb = parts[0], argument = parts.count > 1 ? parts[1] : ""
            print("YM_STEP \(verb)\(argument.isEmpty ? "" : " \(argument)")")
            switch verb {
            case "tap": try tap(app, argument)
            case "expect": try expect(app, argument)
            case "alert": allowAlert(argument)
            case "home": XCUIDevice.shared.press(.home)
            case "banner": try banner(argument)
            case "screenshot": attach(XCUIScreen.main.screenshot(), argument.isEmpty ? "step" : argument)
            case "wait": Thread.sleep(forTimeInterval: Double(argument) ?? 1)
            default: XCTFail("Unknown step \(step)")
            }
        }
        attach(XCUIScreen.main.screenshot(), "final")
    }

    private func matching(_ root: XCUIElement, _ text: String) -> XCUIElement {
        let predicate = NSPredicate(format: "label CONTAINS %@ OR identifier == %@ OR value CONTAINS %@", text, text, text)
        return root.descendants(matching: .any).matching(predicate).firstMatch
    }

    private func tap(_ app: XCUIApplication, _ label: String) throws {
        let button = app.buttons.matching(NSPredicate(format: "label == %@ OR identifier == %@", label, label)).firstMatch
        let target = button.waitForExistence(timeout: timeout) ? button : matching(app, label)
        XCTAssertTrue(target.waitForExistence(timeout: timeout), "No element labeled \(label)")
        target.tap()
    }

    /// Scrolls down a few times if the text is not on screen yet; prints the matched label for the log.
    private func expect(_ app: XCUIApplication, _ text: String) throws {
        let element = matching(app, text)
        var found = element.waitForExistence(timeout: timeout)
        for _ in 0..<6 where !(found && element.isHittable) {
            app.swipeUp()
            found = element.waitForExistence(timeout: 2)
        }
        XCTAssertTrue(found, "Text not found: \(text)")
        print("YM_FOUND \(element.label)")
    }

    /// System permission prompts belong to SpringBoard, not the app under test.
    private func allowAlert(_ button: String) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let choice = springboard.alerts.buttons[button.isEmpty ? "Allow" : button]
        if choice.waitForExistence(timeout: 8) { choice.tap(); print("YM_ALERT tapped \(choice.label)") }
        else { print("YM_ALERT none shown") }
    }

    private func banner(_ text: String) throws {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let element = matching(springboard, text)
        XCTAssertTrue(element.waitForExistence(timeout: 120), "No notification banner containing \(text)")
        element.tap()
    }

    private func attach(_ screenshot: XCUIScreenshot, _ name: String) {
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
