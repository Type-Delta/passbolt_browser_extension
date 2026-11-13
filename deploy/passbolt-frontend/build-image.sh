#!/usr/bin/env sh
# Passbolt ~ Open source password manager for teams
# Copyright (c) Passbolt SA (https://www.passbolt.com)
#
# Licensed under GNU Affero General Public License version 3 of the or any later version.
# For full copyright and license information, please see the LICENSE.txt
# Redistributions of files must retain the above copyright notice.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
TAG=
CONTEXT="$ROOT/dist/server-frontend"
SKIP_BUILD=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      TAG=$2
      shift 2
      ;;
    --context)
      CONTEXT=$2
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    *)
      echo "Usage: $0 [--tag TAG] [--context DIR] [--skip-build]" >&2
      exit 2
      ;;
  esac
done

if [ "$SKIP_BUILD" -eq 0 ]; then
  node "$ROOT/scripts/build-server-assets.mjs" --out "$CONTEXT"
fi
test -f "$CONTEXT/MANIFEST.json"
test -f "$CONTEXT/rootfs/webroot/.passbolt-fork-frontend.json"

node "$ROOT/scripts/validate-frontend-context.mjs" "$CONTEXT"

UI_META=$(node -e '
const fs=require("fs");
const path=require("path");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write([m.ui.version,m.ui.commit,m.ui.commit.slice(0,12),m.ui.localOnly?"local":"release"].join(" "));
' "$CONTEXT/MANIFEST.json")
set -- $UI_META
UI_VERSION=$1
UI_COMMIT=$2
UI_SHORT=$3
UI_MODE=$4
EXTENSION_VERSION=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT/package.json")
BASE_REFERENCE=$(node -e 'process.stdout.write(require(process.argv[1]).reference)' "$SCRIPT_DIR/base-image.json")

if [ -z "$TAG" ]; then
  if [ "$UI_MODE" = "local" ]; then
    TAG="passbolt-frontend:5.16.0-1-ce-ui-${UI_SHORT}-local"
  else
    TAG="passbolt-frontend:5.16.0-1-ce-ui-${UI_SHORT}"
  fi
fi

docker build --pull=false \
  --build-arg "PASSBOLT_BASE=$BASE_REFERENCE" \
  --build-arg "PASSBOLT_UI_VERSION=$UI_VERSION" \
  --build-arg "PASSBOLT_UI_COMMIT=$UI_COMMIT" \
  --build-arg "PASSBOLT_EXTENSION_VERSION=$EXTENSION_VERSION" \
  --file "$ROOT/deploy/passbolt-frontend/Dockerfile" \
  --tag "$TAG" \
  "$CONTEXT"

node "$ROOT/scripts/verify-image.mjs" "$TAG" "$CONTEXT/MANIFEST.json"
printf '%s\n' "$TAG" > "$CONTEXT/IMAGE_TAG.txt"
cat > "$CONTEXT/IMAGE.txt" <<IMAGE_EOF
image=$TAG
base=$BASE_REFERENCE
uiVersion=$UI_VERSION
uiCommit=$UI_COMMIT
extensionVersion=$EXTENSION_VERSION
localOnly=$([ "$UI_MODE" = "local" ] && printf true || printf false)
IMAGE_EOF
printf '[build-image] %s\n' "$TAG"
