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
 * @since         4.8.2
 */
import storage from "../../sdk/storage";
import { Config } from "../../model/config";
import SavedAccountRegistry from "./savedAccountRegistry";

import AccountModel from "../../model/account/accountModel";
import Keyring from "../../model/keyring";

const ACTIVE_ACCOUNT_KEY = "active-account";

class GetActiveAccountService {
  /**
   * Get the active account associated with this extension.
   * @return {Promise<AccountEntity>}
   * @throw {Error} if no account yet associated with this extension.
   */
  get() {
    return navigator.locks.request(ACTIVE_ACCOUNT_KEY, async () => {
      // Check if the storage have some data
      if (Object.keys(storage._data).length === 0) {
        // Fix the initialization of the storage after an update
        await storage.init();
        // Initialization of the config to get the user information
        Config.init();
      }
      const account = await SavedAccountRegistry.active();
      // Recover an interrupted projection on worker restart before any legacy consumer can use it.
      const key = new Keyring().findPrivate();
      if (
        Config.read("user.id") !== account.userId ||
        Config.read("user.settings.trustedDomain") !== account.domain ||
        key?.fingerprint?.toUpperCase() !== account.userKeyFingerprint?.toUpperCase()
      ) {
        await new AccountModel().activate(account);
      }
      return account;
    });
  }
}

export default new GetActiveAccountService();
