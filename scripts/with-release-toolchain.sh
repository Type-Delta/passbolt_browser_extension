#!/usr/bin/env sh
# Passbolt ~ Open source password manager for teams
# Copyright (c) Passbolt SA (https://www.passbolt.com)
#
# Licensed under GNU Affero General Public License version 3 of the or any later version.
# For full copyright and license information, please see the LICENSE.txt
# Redistributions of files must retain the above copyright notice.
#
# Runs npm in an isolated, temporary Node 22.14.0/npm 10.9.2 toolchain.
set -eu
exec npx --yes --package=node@22.14.0 --package=npm@10.9.2 -- npm "$@"
