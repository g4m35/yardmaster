# Device runner for `apple-device`

Smoke checks for an app on a paired iPhone or iPad, for use as `tests` of the
built-in `apple-device` provider. See [docs/DEVICES.md](../../docs/DEVICES.md#physical-devices).

- `scripts/stays-running.mjs`: needs no signing and no UI automation. Passes when
  the app Yardmaster launched is still running, as the same process, after N
  seconds (default 15).
- `YardRunner.xcodeproj`: an XCUITest runner. Its UI test drives any installed
  app by bundle ID with `XCUIApplication(bundleIdentifier:)`. It brings the app
  to the foreground without relaunching it, runs your steps, and saves
  screenshots. `scripts/build.sh` builds it once per machine; `scripts/run.sh`
  is the test command.

## Build the runner once

```sh
YM_RUNNER_TEAM=<your team ID> sh examples/ios-device-runner/scripts/build.sh
```

It needs a development team that Xcode can sign with (Xcode > Settings > Accounts).
Use the team ID shown there, or the `OU` of your "Apple Development" certificate:
`security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject`.
Signing is automatic (`-allowProvisioningUpdates`). With a paid team that already
has a wildcard team profile, nothing new is registered. Otherwise Xcode registers the
`dev.yardmaster.runner` and `dev.yardmaster.runner.uitests` App IDs in that team. If
another team already owns those IDs, set `YM_RUNNER_BUNDLE_ID=com.yourteam.ymrunner`
for both `build.sh` and later runs. With a free Personal Team, each device must
trust your developer certificate once (Settings > General > VPN & Device
Management), and the profile expires after 7 days: build again then.

The output is `build/DerivedData` here (ignored by git). Building takes seconds.

## Use it in `yardmaster.json`

```json
"tests": [{
  "name": "smoke", "runner": "xcodebuild", "timeoutMinutes": 10,
  "command": ["sh", "/path/to/examples/ios-device-runner/scripts/run.sh", "--remove-runner",
    "tap:Profile", "expect:Version 1.0", "screenshot:profile"]
}]
```

Each argument is a step:

| Step | Does |
| --- | --- |
| `tap:<label>` | Taps the button (or any element) with that label or accessibility identifier. |
| `expect:<text>` | Fails unless an element whose label or value contains the text appears, swiping up to six times to find it. |
| `alert:<button>` | Taps that button on a system permission alert if one appears within 8 seconds (default `Allow`). |
| `home` | Presses the Home button. |
| `banner:<text>` | Waits up to 2 minutes for a notification banner containing the text and taps it. |
| `screenshot:<name>` | Saves a screenshot. |
| `wait:<seconds>` | Pauses. |

`run.sh` runs `xcodebuild test-without-building` on `$YARDMASTER_DEVICE_UDID`
against `$YARDMASTER_BUNDLE_ID`. Screenshots are copied to the evidence folder.
The `.xcresult` bundle names the device, so it stays in a temporary folder that is
deleted. `--remove-runner` uninstalls the runner's own two apps afterwards and
nothing else.

The first UI test after each restart or iOS update shows **Enter iPhone Passcode
for "XCTest": Enable UI Automation** on the device. Someone has to enter the
passcode on the device once. Until then the test fails with "Timed out while
enabling automation mode".
