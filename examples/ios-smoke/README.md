# iOS simulator smoke sample

A one-screen SwiftUI app for trying Yardmaster's device verification without an
account. See [docs/DEVICES.md](../../docs/DEVICES.md).

- `Smoke.xcodeproj` with a shared `Smoke` scheme (iOS 17+).
- `yardmaster.json`: a shell check, then `device.test` through the built-in
  `apple-simulator` provider: build with `xcodebuild`, lease and create a
  simulator, install, launch, screenshot, run `scripts/smoke-test.sh`, delete the
  simulator.
- `scripts/smoke-test.sh` passes only if the launched app wrote its marker file,
  so it proves app code ran, not only that it installed.
- `scripts/fingerprint.sh` is the build-reuse key: the committed sources and
  project. Change either and the next run builds again.
- `maestro/smoke.yaml` is an optional Maestro flow. With a working Maestro install,
  add `{ "name": "maestro", "runner": "maestro", "flow": "maestro/smoke.yaml" }`
  to `tests`.

```sh
cp -R examples/ios-smoke ~/ios-smoke && cd ~/ios-smoke
git init -q && git add -A && git commit -qm "smoke sample"
ym verify --json
ym devices evidence
```

Needs macOS with Xcode and an installed iOS simulator runtime. The build writes
to `build/` (ignored). Nothing here signs for or installs on a physical device.
