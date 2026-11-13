import SavedAccountsService from "../../service/account/savedAccountsService";
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
 * @since         5.10.0
 */

import OpenTrustedDomainTabService from "../../service/ui/openTrustedDomainTabService";

export default class OpenTrustedDomainTabController {
  /**
   * @constructor
   * @param {Worker} worker The associated worker.
   * @param {string} requestId The associated request id.
   */
  constructor(worker, requestId) {
    this.worker = worker;
    this.requestId = requestId;
    this.openTrustedDomainTabService = new OpenTrustedDomainTabService();
  }

  /**
   * Wrapper of exec function to run it with worker.
   * @return {Promise<void>}
   */
  async _exec() {
    try {
      await this.exec();
      this.worker.port.emit(this.requestId, "SUCCESS");
    } catch (error) {
      console.error(error);
      this.worker.port.emit(this.requestId, "ERROR", error);
    }
  }

  /**
   * Opens the trusted domain in a new tab
   * @returns {Promise<void>}
   */
  async exec() {
    const pending = await SavedAccountsService.pending();
    if (pending?.saved) {
      const account = await SavedAccountRegistry.active();
      if (SavedAccountRegistry.account(pending.account).id === account.id) {
        const result = SavedAccountsService.pendingResult(account, pending);
        await SavedAccountsService.navigate(result, pending.tab_id === null ? {} : { tab: { id: pending.tab_id } });
        return;
      }
    }
    await this.openTrustedDomainTabService.openTab();
  }
}
