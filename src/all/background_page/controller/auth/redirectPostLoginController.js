import SavedAccountsService from "../../service/account/savedAccountsService";
import SavedAccountRegistry from "../../service/account/savedAccountRegistry";
import PortManager from "../../sdk/port/portManager";
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
 * @since         5.4.0
 */

export default class RedirectPostLoginController {
  /**
   * @constructor
   * @param {Worker} worker
   * @param {string} requestId
   * @param {AbstractAccountEntity} apiClientOptions the api client options
   */
  constructor(worker, requestId, account) {
    this.worker = worker;
    this.requestId = requestId;
    this.account = account;
  }

  /**
   * Controller executor.
   * @returns {Promise<void>}
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
   * Redirects the user to the app main page
   * or to the redirect url if a `redirect` parameter is given in the worker URL.
   * @returns {Promise<void>}
   */
  async exec() {
    const pending = await SavedAccountsService.pending();
    if (pending?.saved && SavedAccountRegistry.account(pending.account).id === this.account.id) {
      if (
        !(await PortManager.isAccountManagementSender(
          "Auth",
          this.worker.port._port.sender,
          this.worker.port._port.name,
        ))
      ) {
        throw new Error("Open the selected account's sign-in page to complete MFA.");
      }
      await SavedAccountsService.navigate(SavedAccountsService.pendingResult(this.account, pending), this.worker);
      return;
    }
    const workerUrl = new URL(this.worker.tab.url);
    const redirectTo = workerUrl.searchParams.get("redirect");

    const url = /^\/[A-Z/-9\-]*$/i.test(redirectTo) ? `${this.account.domain}${redirectTo}` : this.account.domain;

    chrome.tabs.update(this.worker.tab.id, { url });
  }
}
