# Devices: simulator leases and device evidence

Yardmaster can check an iPhone app on a simulator, or on a paired iPhone or iPad
(see [Physical devices](#physical-devices)), as part of task acceptance, with no
cloud account. It works with any project that can produce a simulator `.app`
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
| `status.physical` | `untested` from `apple-simulator`. `apple-device` (or a provider plugin that drove real hardware) reports `passed`, `failed` or `unknown`. |
| `status.overall` | `passed` only when the stated requirement was met on that class of device. |

Acceptance (`ym verify`, managed tasks and merge trains) treats them like other
provider checks: a failed build, launch or test enters the normal repair loop; an
unknown result (unavailable tool, timeout, cancellation, unconfirmed cleanup, no
slot within `waitMinutes`, or an untested physical requirement) stops for you
without an automatic retry. Evidence that names a different commit than the one
being accepted never passes, whichever provider produced it.

The required level comes from the check's input (`{"requires": "physical"}`) or
the project's provider options, never from what a provider reports or how it
classifies itself. Once a level is stated, a pass without matching device
evidence is unknown. A pass must match its device: a physical pass needs
evidence naming a physical device with `physical: passed`, and a build of the
commit: evidence from an app that was already installed (`deviceApp` with no
`artifact`) does not accept a commit.

Declared `requiredEnv` values never stay in evidence. Text logs and reports are
redacted, whatever their size; overlapping values are redacted as one span.
Only files confidently identified as text (a text extension such as `.log`,
`.txt`, `.xml` or `.json`, valid UTF-8 throughout, no NUL byte) are rewritten.
Anything else (screenshots, protobuf reports, archives) is never rewritten: one
that contains a declared value is removed and listed under `omitted`; the rest
stay byte-identical. Evidence is accepted and recorded only for the request
that produced it: its request id, and its project and task when the check has
them, must match.

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
- `resources.holdAtPressure` (default `critical`) and the memory limit apply before
  the first task as well as later ones. The load limit (`maxLoadPerCpu`) applies
  only once a task is running, so a busy machine with nothing running still
  makes progress.
- Holders renew their lease. A lease is freed only when its holder's process is
  gone: PID plus process start time, so a reused PID does not count, and the
  machine's boot identity, so a PID from before a reboot never counts. No lease
  is granted to a process whose start time cannot be read. A live
  holder that stopped renewing keeps its slot: it may still be building or
  testing, and `ym devices status` marks it stale. Freeing first deletes the simulators that lease
  recorded, after checking each still has the unique `ym-...` name it was given.
  If that cleanup fails, the slot stays occupied and visible rather than being
  handed out again.
- Cancelling a task or `ym verify` stops its processes, deletes its simulator and
  releases its slot. A build, test or `ym devices lease` command that cannot be
  confirmed stopped keeps its slot: the lease records the process (PID and start
  time), and the reaper frees the slot only after confirming that process is gone.
- The built app is copied while the build slot is still held. That copy is what
  gets hashed, installed and cached, so a later build writing the same output
  path cannot change what a waiting run tests.

```sh
ym devices status            # limits, memory admission, held and queued leases
ym devices reap              # free leases whose holder process is gone (the hub also does this)
ym devices release <id> --note "deleted the leftover simulator by hand"   # after a failed cleanup
ym devices recover <id> --note "host rebooted; old controller is gone"     # stale claim with no verifiable holder
ym devices lease simulator -- maestro --device <udid> test flow.yaml       # any tool, any project
```

`ym devices lease` holds a slot for any command (exit code passes through; its environment is filtered like
shell checks, with `env.checks.pass` exceptions), so a
script or another agent can share the same queue. It records no simulator: the
command manages its own device and processes. T3 or other device panels are
optional; Yardmaster does not lease, control or clean up their sessions.

Leases are per machine. The hub's dashboard and MCP show the hub machine's
leases; a remote worker coordinates its own simulators in its own database.

## Physical devices

The built-in `apple-device` provider tests on a real iPhone or iPad connected to
this Mac, through Xcode's `xcrun devicectl`. It is opt-in: nothing touches a
device until you configure it and route `device.test` to it. The
`apple-simulator` provider never drives hardware; with it, a
`"requires": "physical"` check ends `physical: untested` and acceptance waits
for you.

### Setup checklist

1. **Xcode 15 or later** (`xcrun --find devicectl` must succeed; `xcode-select -p`
   must point at Xcode, not the Command Line Tools).
2. **Pair and trust**: connect the device with a cable, unlock it and tap
   **Trust**. After the first pairing it can also be reached over the local
   network. Check with `xcrun devicectl list devices`.
3. **Developer Mode**: Settings > Privacy & Security > Developer Mode, then
   restart the device. It appears after Xcode has seen the device once.
4. **Keep it unlocked** during runs. A locked device is reported unavailable.
5. **UI automation** (only for XCTest UI tests, such as the runner below): the
   first UI test after each restart or iOS update shows **Enter iPhone Passcode
   for "XCTest": Enable UI Automation** on the device. Someone has to enter the
   passcode there; until then UI tests fail with "Timed out while enabling
   automation mode". Settings > Developer > Enable UI Automation must be on.
6. **Signing**, only if Yardmaster installs a build or you use the runner: a
   development certificate and a team in Xcode > Settings > Accounts. Builds for
   a device are signed `.app` (or `.ipa`) files for `iphoneos`. A free Personal
   Team also works, but each device must then trust the developer once
   (Settings > General > VPN & Device Management), and profiles expire after 7
   days.

### Configure

```json
{
  "services": {
    "providers": {
      "apple-device": {
        "options": {
          "bundleId": "com.example.myapp",
          "device": { "udid": "00008150-0000000000000000" },
          "tests": [{ "name": "smoke", "runner": "command", "command": ["node", "scripts/stays-running.mjs", "15"] }]
        }
      }
    },
    "routes": { "device.test": { "prefer": ["apple-device"] } },
    "verify": [{ "capability": "device.test" }]
  }
}
```

| Option | Meaning |
| --- | --- |
| `bundleId` | The app to launch and test. |
| `requires` | `physical` (default) or `simulator`. A physical pass satisfies both. |
| `device.udid`, `device.name` | Which device (one of them). Default: the only paired iPhone or iPad; several paired devices need one of these. |
| `build` | Optional `{ command?, app, timeoutMinutes? }`: a device-signed `.app` or `.ipa` to install, built under the machine-wide build slot like the simulator's. Without `build`, the run tests the copy already installed and installs nothing. |
| `install.replaceExisting` | Install over a copy of `bundleId` that this run did not install (the app's data stays). Default `false`: such a run stops as unavailable. |
| `install.uninstallAfter` | Remove the app afterwards, only if this run installed it fresh. Default `false`. A copy that existed before the run is never removed. |
| `launch` | Launch the app, confirm it is running and screenshot it (default `true`). |
| `settleSeconds` | How long the app gets to draw before the launch screenshot (default 4). |
| `tests` | As for the simulator. `build`, `device`, `install`, `launch`, `app-running`, `stop`, `crash-reports` and `uninstall` are reserved names. |
| `requiredEnv` | As for the simulator. |

A run holds the `physical` lease from discovery to the end, and records the
device (by its hashed key) on the lease, so two runs never share one device even
when `limits.physical` is raised for several devices. In order it:

1. **Discovers** the device (`devicectl list devices`, `device info lockState`).
   No device, an unpaired or untrusted one, one that is paired but not reachable
   now (unplugged), Developer Mode off, a locked device, one that does not answer, several candidates with none configured, or a
   missing `devicectl` are each reported **unavailable** with the reason. That is
   never a pass.
2. **Installs** the configured build, if any, from the run's own hashed copy, after
   checking its `Info.plist` bundle ID matches `bundleId` (also for an IPA's Payload app). It
   never installs over an app it did not install unless `install.replaceExisting`
   says so, and never removes one. In installed-app mode, `bundleId` must already
   be installed. No other app on the device is touched.
3. **Launches** the app with `devicectl device process launch --console
   --terminate-existing` (a running copy is restarted), confirms its process is running, waits
   `settleSeconds` and takes a screenshot (`devicectl device capture
   screenshot`). The app's stdout and stderr become `app-console.log`.
4. **Runs your tests** with `YARDMASTER_DEVICE_KIND=physical` and the real UDID in
   `YARDMASTER_DEVICE_UDID` and `{udid}`, so tools can address the device.
5. **Confirms** the launched process is still running before intentional shutdown,
   takes a final screenshot, stops the app, and copies any crash
   report the app wrote during the run (`devicectl device copy from --domain-type
   systemCrashLogs`). An unexpected app exit or a new crash report fails the run.
   App termination and console cleanup also run when saving evidence fails.

`devicectl` also offers `sysdiagnose` and app-container copies. Yardmaster does
not collect them: both are large and hold personal data from the whole device or
the app's account.

### Smoke tests for a device

- **No UI automation**:
  [`examples/ios-device-runner/scripts/stays-running.mjs`](../examples/ios-device-runner/scripts/stays-running.mjs)
  passes when the launched app is still running, as the same process, after N
  seconds. With the launch screenshot, console log and crash-report check, that
  catches crashes on start without any signing.
- **XCUITest runner**: [`examples/ios-device-runner`](../examples/ios-device-runner)
  is a small Xcode project whose UI test drives any installed app by bundle ID
  (`XCUIApplication(bundleIdentifier:)`): bring it to the foreground, tap
  labels, assert text (scrolling to find it), answer a permission alert, press
  Home, take screenshots. Build it once per machine with your team, then use
  `run.sh` as a test command. See its README.
- **Your own XCTest target**:
  `["xcodebuild", "test", "-project", "MyApp.xcodeproj", "-scheme", "MyAppUITests", "-destination", "id={udid}", "-allowProvisioningUpdates"]`.
- **agent-device** supports physical iOS devices through its own XCTest runner,
  for example `["agent-device", "open", "{bundleId}", "--platform", "ios", "--udid", "{udid}"]`
  followed by its snapshot or screenshot commands. It keeps its own device
  sessions; Yardmaster's lease does not manage them.

Maestro does not support physical iOS devices.

### Evidence for a physical device

`device.kind` is `physical`, with the model, model identifier and iOS version
and build. `device.udid` holds a stable hashed key (`d-` and 20 hex digits, the
same for that device on every machine), never the hardware UDID. The UDID,
CoreDevice identifier, serial number, ECID and the device's own name (often a
person's name) are redacted from every saved text file, test output included;
the hashed key appears in their place in messages. `devicectl`'s own JSON, which
contains them, stays in private scratch space and is deleted.

`deviceApp` records the app as found on the device: name, version, build, and
whether this run installed it. A run without `build` tested someone else's copy,
so its evidence says so (`installed app 1.0 (20), not built from this commit`)
and **cannot accept a commit**: acceptance requires a build of the commit for a
physical pass. Such a run is still useful as a device smoke check through
`ym providers run device.test`.

The same restriction applies to `build.app` without `build.command`: the prebuilt
artifact can be installed and smoke-tested, but has no demonstrated commit binding.
Physical acceptance requires `artifact.builtFromCommit` to match the requested commit.
Before running a build, Yardmaster discovers device identifiers so build transcripts
are redacted even if the build fails. Saved text is scrubbed and rehashed again after
device discovery.

## Limits

- macOS with Xcode only for the built-in adapter. Discovery reports it
  unavailable elsewhere.
- Coordination covers Yardmaster processes sharing one `YARDMASTER_HOME`. Other
  programs are seen only through memory pressure and are never touched.
- `ym devices lease` cannot clean up after a command that is killed together with
  its parent.
- The macOS CI job proves the simulator path on GitHub's runners. CI has no
  iPhone: the physical path is covered by unit tests against a stand-in
  `devicectl` and by manual runs on a real iPhone (iOS 27, Xcode 27.2).
- `apple-device` works with iPhones and iPads. Apple TV, Apple Watch and Vision
  devices are not selected.
- UI automation needs someone at the device once after each restart (the
  passcode prompt above). Nothing can answer it remotely.
- A run that crashes between installing and `install.uninstallAfter` leaves the
  app installed; nothing on the device is recorded for the reaper to remove.
- Installed-app runs cannot accept a commit (above).
