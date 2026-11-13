# syntax=docker/dockerfile:1
#
# Passbolt ~ Open source password manager for teams
# Copyright (c) Passbolt SA (https://www.passbolt.com)
#
# Licensed under GNU Affero General Public License version 3 of the or any later version.
# For full copyright and license information, please see the LICENSE.txt
# Redistributions of files must retain the above copyright notice.
#
# This image only overlays the matched fork web UI onto an immutable stock
# Passbolt server image. Database, backend API logic, entrypoint, and volumes
# remain inherited from the base image.
ARG PASSBOLT_BASE=passbolt/passbolt@sha256:1768916a04b10a3ade0d2162b00febe602fd7d32cda3808391529600787c67bd
FROM ${PASSBOLT_BASE}

ARG PASSBOLT_UI_VERSION=unknown
ARG PASSBOLT_UI_COMMIT=unknown
ARG PASSBOLT_EXTENSION_VERSION=unknown

LABEL org.opencontainers.image.title="Passbolt multi-account frontend" \
      org.opencontainers.image.description="Matched Passbolt fork web UI layered onto a pinned stock Passbolt 5.16.0 image" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      com.passbolt.fork.ui.version="${PASSBOLT_UI_VERSION}" \
      com.passbolt.fork.ui.commit="${PASSBOLT_UI_COMMIT}" \
      com.passbolt.fork.extension.version="${PASSBOLT_EXTENSION_VERSION}"

# rootfs contains webroot assets and the allowlisted cache-revised templates from
# scripts/build-server-assets.mjs. This COPY adds one image layer and does not
# alter inherited entrypoint, command, environment, or volume declarations.
COPY rootfs/ /usr/share/php/passbolt/
