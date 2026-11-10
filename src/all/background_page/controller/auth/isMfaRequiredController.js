import PendingAccountSessionStorage from "../../service/account/pendingAccountSessionStorage";
import SavedAccountRegistry from "../../service/account/savedAccountRegistry";
/**
 * Passbolt ~ Open source password manager for teams
 * Copyright (c) Passbolt SA (https://www.passbolt.com)
 *
 * Licensed under GNU Affero General Public License version 3 of the or any later version.
 * For full copyright and license information, please see the LICENSE.txt
 * Redistributions of files must retain the above copyright notice.
 *
 * @copyright     Copyright (c) Passbolt SA (https://www.passbolt.com)
 * @license       https://opensource.org/licenses/AGPL-3.0 AGPL License
 * @link          https://www.passbolt.com Passbolt(tm)
 * @since         2.11.0
 */
import FindAndUpdateActiveSessionLocalStorageService from "../../service/activeSession/findAndUpdateActiveSessionLocalStorageService";

class IsMfaRequiredController {
  /**
   * FindAndUpdateActiveSessionLocalStorageController Constructor
   *
   * @param {Worker} worker
   * @param {string} requestId
   * @param {ApiClientOptions} apiClientOptions
   * @param {AccountEntity} account
   */
  constructor(worker, requestId, apiClientOptions, account) {
    this.account = account;
    this.worker = worker;
    this.requestId = requestId;
    this.findAndUpdateActiveSessionLocalStorageService = new FindAndUpdateActiveSessionLocalStorageService(
      account,
      apiClientOptions,
    );
  }

  /**
   * Execute the controller.
   */
  async _exec() {
    try {
      const isMfaRequired = await this.exec();
      this.worker.port.emit(this.requestId, "SUCCESS", isMfaRequired);
    } catch (error) {
      this.worker.port.emit(this.requestId, "ERROR", error);
    }
  }

  /**
   * Returns user active session
   * @returns {Promise<boolean>}
   */
  async exec() {
    const pending = await PendingAccountSessionStorage.read();
    if (pending?.saved && SavedAccountRegistry.account(pending.account).id === this.account.id) {
      return true;
    }
    const activeSession = await this.findAndUpdateActiveSessionLocalStorageService.findAndUpdateAuthenticationStatus();
    return activeSession.isMfaRequired;
  }
}

export default IsMfaRequiredController;
