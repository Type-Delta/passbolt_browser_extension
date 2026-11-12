/**
 * Passbolt ~ Open source password manager for teams
 * Copyright (c) 2022 Passbolt SA (https://www.passbolt.com)
 *
 * Licensed under GNU Affero General Public License version 3 of the or any later version.
 * For full copyright and license information, please see the LICENSE.txt
 * Redistributions of files must retain the above copyright notice.
 *
 * @copyright     Copyright (c) 2022 Passbolt SA (https://www.passbolt.com)
 * @license       https://opensource.org/licenses/AGPL-3.0 AGPL License
 * @link          https://www.passbolt.com Passbolt(tm)
 * @since         3.6.0
 */

import ValidatePrivateGpgKeyService from "../../service/crypto/validatePrivateGpgKeyService";

class ValidatePrivateGpgKeyRecoverController {
  /**
   * ValidateGpgKeyController constructor
   * @param {Worker} worker
   * @param {string} requestId uuid
   */
  constructor(worker, requestId) {
    this.worker = worker;
    this.requestId = requestId;
  }

  /**
   * Wrapper of exec function to run it with worker.
   *
   * @param {string} key the key to validate.
   */
  async _exec(key) {
    try {
      await this.exec(key);
      this.worker.port.emit(this.requestId, "SUCCESS");
    } catch (error) {
      console.error(error);
      this.worker.port.emit(this.requestId, "ERROR", error);
    }
  }

  /**
   * Get the given user key information.
   *
   * @param {string} armoredKey the key to validate.
   * @throws {Error} if the key is not a valid GPG Key.
   * @throws {Error} if the key is revoked.
   * @throws {Error} if the key is expired.
   * @throws {Error} if the key is not private.
   * @throws {Error} if the key is decrypted.
   */
  async exec(armoredKey) {
    await ValidatePrivateGpgKeyService.validate(armoredKey);
  }
}

export default ValidatePrivateGpgKeyRecoverController;
