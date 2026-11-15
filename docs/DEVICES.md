# Devices: simulator leases and device evidence

Yardmaster can check an iPhone app on a simulator as part of task acceptance, with
no cloud account. It works with any project that can produce a simulator `.app`
(Swift, React Native, Expo, Flutter) and uses tools you already have: your build
command, Xcode's `xcrun simctl`, and optionally Maestro, `xcodebuild test` or
agent-device. Hosted build and device services stay optional provider plugins.

What it adds:

- **Machine-wide leases** for scarce resources: a build slot, a simulator, a
  physical device. Every project, hub, worker and CLI on the machine (sharing one
  `YARDMASTER_HOME`) waits in one queue. Leases survive hub restarts.
- **Memory admission**: heavy device work waits while macOS reports memory
  pressure, and new tasks are now checked before the first one starts too.
- **Ownership**: Yardmaster creates its own simulator for each run, records it in
  the lease before creating it, and deletes it afterwards. It never boots, erases,
  shuts down or deletes a simulator or device it did not create. Another session's
  booted simulator is left alone.
- **Evidence**: each run records the commit, the app's sha256, the machine and
  Xcode, the device model and iOS runtime, every check that ran, screenshots and
  logs. Code, simulator and physical-device results are separate. A simulator pass
  never satisfies a physical-device requirement.

## Try it with the sample app

[`examples/ios-smoke`](../examples/ios-smoke) is a one-screen SwiftUI app with an
Xcode scheme and a smoke test. On a Mac with Xcode and an iOS simulator runtime:

```sh
cp -R examples/ios-smoke ~/ios-smoke && cd ~/ios-smoke
git init -q && git add -A && git commit -qm "smoke sample"
ym verify --json          # shell check, build, lease, install, launch, smoke test, evidence
ym devices evidence       # PASSED <sha>: code passed, simulator passed, physical device untested [...]
```

The first run builds the app (a minute or two). Later runs with unchanged app
sources reuse that build: its fingerprint script hashes the committed sources and
project file. CI runs this exact sample on `macos-latest` with the competing,
canceled and crashed cases (`scripts/device-live.mjs`).

## Configure a project

Enable the built-in `apple-simulator` provider, route `device.test` to it, and
make it an acceptance check:

```json
{
  "verify": ["npm test"],
  "services": {
    "providers": {
      "apple-simulator": {
        "options": {
          "bundleId": "com.example.myapp",
          "requires": "simulator",
          "build": {
            "command": ["sh", "scripts/build-ios-sim.sh"],
            "app": "build/DerivedData/Build/Products/Release-iphonesimulator/MyApp.app"
          },
          "simulator": { "deviceType": "iPhone 17", "runtime": "iOS 26.5" },
          "tests": [{ "name": "smoke", "runner": "maestro", "flow": "maestro/smoke.yaml" }]
        }
      }
    },
    "routes": { "device.test": { "prefer": ["apple-simulator"] } },
    "verify": [{ "capability": "device.test" }]
  }
}
```

| Option | Meaning |
| --- | --- |
| `bundleId` | The app's bundle identifier; used to launch it. |
| `requires` | `simulator` (default) or `physical`. A per-check input `{"requires": "physical"}` overrides it. |
| `build.command` | Your existing build, as an argument array. Omit it if an earlier check already produced the app. |
| `build.app` | The `.app` the build produces, relative to the project. |
| `build.reuse`, `build.fingerprint` | `"fingerprint"` reuses an earlier build only when your command reports the same key (below). Default `never`. |
| `simulator.deviceType`, `simulator.runtime` | Name or identifier. Default: newest installed iOS runtime and its first iPhone. |
| `simulator.bootTimeoutMinutes` | Default 5. |
| `launch` | Launch the app and screenshot it (default `true`): the minimal smoke check. |
| `tests` | Up to 10 checks, each `{ name, runner, command?, flow?, timeoutMinutes? }`. `build`, `boot`, `install` and `launch` are reserved names. |
| `requiredEnv` | Extra environment variables your build or tests need. Other variables are not inherited. |

`runner` is `command`, `maestro`, `xcodebuild` or `agent-device`. Commands can use
`{udid}`, `{app}`, `{bundleId}`, `{artifacts}` and `{sha}`, and receive
`YARDMASTER_DEVICE_UDID`, `YARDMASTER_DEVICE_KIND`, `YARDMASTER_APP_PATH`,
`YARDMASTER_BUNDLE_ID`, `YARDMASTER_ARTIFACT_DIR` and `YARDMASTER_VERIFY_SHA`.
Files written to the artifact directory become part of the evidence.

A Maestro check with only a `flow` runs
`maestro --device {udid} test --format junit --output {artifacts}/report.xml <flow>`.
For an XCTest UI test target, use your own command, for example
`["xcodebuild", "test", "-project", "MyApp.xcodeproj", "-scheme", "MyAppUITests", "-destination", "id={udid}"]`.

A tool that is not installed, or that fails its `--version` check (Maestro
without Java, for example), is reported **unavailable** and the run is
**unknown**. It is never a pass. Discovery (`ym providers plan device.test`)
checks only that `xcrun` exists and the options are valid; it boots nothing.

### Build recipes

Use a Release (or otherwise self-contained) simulator build: nothing starts a
Metro or other development server.

**Swift / Xcode project**

```json
"build": {
  "command": ["xcodebuild", "-project", "MyApp.xcodeproj", "-scheme", "MyApp", "-sdk", "iphonesimulator",
    "-configuration", "Debug", "-derivedDataPath", "build/DerivedData", "CODE_SIGNING_ALLOWED=NO", "build"],
  "app": "build/DerivedData/Build/Products/Debug-iphonesimulator/MyApp.app"
}
```

Use `-workspace MyApp.xcworkspace` with CocoaPods or a workspace. Add `build/` to
`.gitignore`: acceptance requires a clean checkout.

**Expo (prebuild) and React Native**

```sh
#!/bin/sh
# scripts/build-ios-sim.sh
set -eu
npx expo prebuild --platform ios --no-install   # Expo only; skip if ios/ is committed (bare React Native)
(cd ios && pod install)
xcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp -configuration Release -sdk iphonesimulator \
  -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO build
```

with `"app": "build/DerivedData/Build/Products/Release-iphonesimulator/MyApp.app"`.
Release embeds the JavaScript bundle. No Expo account is needed. EAS builds are an
optional route through a provider plugin, not a requirement.

**Flutter**: `["flutter", "build", "ios", "--simulator"]` with
`"app": "build/ios/iphonesimulator/Runner.app"`. Check the path your Flutter
version prints.

### Build reuse

Set `"reuse": "fingerprint"` and a `fingerprint` command that prints either one
token or JSON with a `hash` field. A later run reuses the stored build only when
the key matches exactly and the stored artifact still hashes to what was recorded.
An empty, multi-line or failed fingerprint builds normally. The evidence records
`source: "reused"` and the commit the build came from.

The key must cover every input of the app you test. The sample hashes its
committed sources and project. For Expo, `npx expo-updates fingerprint:generate
--platform ios` (or `npx @expo/fingerprint .`) covers native inputs only, while a
Release build also embeds JavaScript: reusing on that key alone would test old
JavaScript. Leave reuse off for Expo/React Native unless your build command also
repacks the app with the current JavaScript.

## Results

Each check is `passed`, `failed`, `unknown`, `unavailable` or `skipped` (a reused
build). The evidence keeps three separate answers:

| Field | Values |
| --- | --- |
| `status.code` | `passed` when the project's shell checks passed on this commit first (acceptance runs them before devices), else `not-run`. |
| `status.simulator` | `passed`, `failed`, `unknown` or `not-run`. |
| `status.physical` | `untested` with this adapter. Only a provider that drove real hardware can report it. |
| `status.overall` | `passed` only when the stated requirement was met on that class of device. |

Acceptance (`ym verify`, managed tasks and merge trains) treats them like other
provider checks: a failed build, launch or test enters the normal repair loop; an
unknown result (unavailable tool, timeout, cancellation, unconfirmed cleanup, no
slot within `waitMinutes`, or an untested physical requirement) stops for you
without an automatic retry. Evidence that names a different commit than the one
being accepted never passes, whichever provider produced it.

Where to read it:

- `ym devices evidence [--task t-...] [--json]` on the machine that ran it.
- The private receipt: `YARDMASTER_HOME/service-runs/<request-id>/` holds
  `result.json`, `device-evidence.json`, screenshots and logs.
- The dashboard: a task's **Details** tab shows code, simulator and physical
  results, the device and runtime, the commit, the artifact hash and the checks.
- MCP: `yard_devices` (read-only) for agents.

## Leases and admission

Pools are `build`, `simulator` and `physical`. Limits come from the global config
(`YARDMASTER_HOME/config.json`) and are shared by every project on the machine. A
project's `yardmaster.json` can lower them for its own requests, never raise them:

```json
{
  "devices": {
    "limits": { "build": 1, "simulator": 1, "physical": 1 },
    "holdAtPressure": "warn",
    "minFreeMemMb": 2048,
    "leaseMinutes": 5,
    "waitMinutes": 30
  },
  "resources": { "holdAtPressure": "critical" }
}
```

- Requests wait in arrival order. The one at the head checks memory before it
  takes a free slot. `holdAtPressure` is the macOS kernel pressure level at which
  heavy work waits (`warn`, `critical` or `off`); `minFreeMemMb` uses memory the
  OS can actually hand out. Swap is not a signal: it records the past.
- `resources.holdAtPressure` (default `critical`) and the existing load and memory
  limits now apply before the first task as well as later ones.
- Holders renew their lease. A lease is freed when its holder's process is gone
  (PID plus process start time, so a reused PID does not count) or it stopped
  renewing for `leaseMinutes`. Freeing first deletes the simulators that lease
  recorded, after checking each still has the unique `ym-...` name it was given.
  If that cleanup fails, the slot stays occupied and visible rather than being
  handed out again.
- Cancelling a task or `ym verify` stops its processes, deletes its simulator and
  releases its slot.
- The built app is copied while the build slot is still held. That copy is what
  gets hashed, installed and cached, so a later build writing the same output
  path cannot change what a waiting run tests.

```sh
ym devices status            # limits, memory admission, held and queued leases
ym devices reap              # free leases of crashed or expired holders now (the hub also does this)
ym devices release <id> --note "deleted the leftover simulator by hand"   # after a failed cleanup
ym devices lease simulator -- maestro --device <udid> test flow.yaml       # any tool, any project
```

`ym devices lease` holds a slot for any command (exit code passes through), so a
script or another agent can share the same queue. It records no simulator: the
command manages its own device and processes. T3 or other device panels are
optional; Yardmaster does not lease, control or clean up their sessions.

Leases are per machine. The hub's dashboard and MCP show the hub machine's
leases; a remote worker coordinates its own simulators in its own database.

## Physical devices

The built-in adapter never drives hardware, so a `"requires": "physical"` check
ends with simulator results and `physical: untested`, and acceptance waits for
you. Apple recommends real hardware for camera, sensors, performance and similar
behavior. Testing on an iPhone needs a paired, trusted device with Developer Mode
on, a development-signed build, and a runner that supports physical devices
(Maestro does not on iOS; XCTest or Appium do). A provider plugin for your device
or lab can report `device.kind: "physical"` evidence through the JSON protocol in
[PROVIDERS.md](PROVIDERS.md); it should hold the `physical` lease while it uses the
device.

## Limits

- macOS with Xcode only for the built-in adapter. Discovery reports it
  unavailable elsewhere.
- Coordination covers Yardmaster processes sharing one `YARDMASTER_HOME`. Other
  programs are seen only through memory pressure and are never touched.
- `ym devices lease` cannot clean up after a command that is killed together with
  its parent.
- The macOS CI job proves the simulator path on GitHub's runners. Nothing here
  has been run against a physical iPhone.
