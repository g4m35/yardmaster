#!/bin/sh
# Build-reuse key: the committed app sources and project. Any change to either builds again.
set -eu
git rev-parse HEAD:./Smoke HEAD:./Smoke.xcodeproj | shasum -a 256 | cut -d' ' -f1
