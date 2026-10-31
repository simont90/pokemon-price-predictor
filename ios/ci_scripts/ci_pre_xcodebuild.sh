#!/bin/sh
# Xcode Cloud runs this before every xcodebuild action.
#
# TestFlight rejects an upload whose build number it has already seen, so
# archives take Xcode Cloud's own build counter, which only ever goes up.
# The committed project stays at 1; nothing here is pushed back to git.
set -eu

if [ "${CI_XCODEBUILD_ACTION:-}" = "archive" ] && [ -n "${CI_BUILD_NUMBER:-}" ]; then
  PBX="$CI_PRIMARY_REPOSITORY_PATH/ios/PricePredictor.xcodeproj/project.pbxproj"
  sed -i '' -E "s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = ${CI_BUILD_NUMBER};/g" "$PBX"
  echo "Build number set to ${CI_BUILD_NUMBER}"
fi
