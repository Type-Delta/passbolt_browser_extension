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
 * @since         3.8.0
 */
import Log from "../../model/log";
import UserPassphraseRequiredError from "passbolt-styleguide/src/shared/error/userPassphraseRequiredError";

const PASSPHRASE_FLUSH_ALARM = "PassphraseStorageFlush";
const PASSPHRASE_STORAGE_KEY = "passphrase";

class PassphraseStorageService {
  /**
   * Stores the passphrase in session memory for given a duration.
   * @param {string} passphrase
   * @param {number|null} timeout duration in second before flushing passphrase
   * @return {Promise<void>}
   */
  static async slot(accountId) {
    if (accountId === undefined) {
      const state = (await browser.storage.local.get("saved-accounts-v1"))["saved-accounts-v1"];
      accountId = state?.active_account_id;
    }
    return accountId ? `${PASSPHRASE_STORAGE_KEY}:${accountId}` : PASSPHRASE_STORAGE_KEY;
  }

  static alarm(slot) {
    return slot === PASSPHRASE_STORAGE_KEY ? PASSPHRASE_FLUSH_ALARM : `${PASSPHRASE_FLUSH_ALARM}:${slot}`;
  }

  static async set(passphrase, timeout, accountId) {
    const slot = await this.slot(accountId);
    const expires = timeout >= 0 ? Date.now() + timeout * 1000 : null;
    await navigator.locks.request(slot, async () => {
      await browser.storage.session.set({ [slot]: { passphrase, expires } });
      await browser.alarms.clear(this.alarm(slot));
      if (expires !== null) {
        await browser.alarms.create(this.alarm(slot), { when: expires });
      }
    });
  }

  /**
   * Retrieve the passphrase from the session memory if any.
   * @return {Promise<string|null>}
   */
  static async get(accountId) {
    const slot = await this.slot(accountId);
    return navigator.locks.request(slot, async () => {
      const data = (await browser.storage.session.get(slot))[slot];
      if (!data) {
        return null;
      }
      // Old unscoped session values cannot be attributed safely after migration.
      if (typeof data !== "object" || (data.expires !== null && Date.now() >= data.expires)) {
        await browser.storage.session.remove(slot);
        return null;
      }
      return data.passphrase || null;
    });
  }

  /**
   * Retrieve the passphrase from the session storage or fail=.
   * @return {Promise<string|null>}
   * @throws {UserPassphraseRequiredError} If no user passphrase stored.
   */
  static async getOrFail() {
    const passphrase = await this.get();
    if (!passphrase) {
      throw new UserPassphraseRequiredError();
    }

    return passphrase;
  }

  /**
   * Removes the stored passphrase from the session memory and resets alarms.
   * @return {Promise<void>}
   */
  static async flush(accountId) {
    Log.write({ level: "debug", message: "PassphraseStorageService flushed" });
    const slot = await this.slot(accountId);
    await navigator.locks.request(slot, async () => {
      await browser.storage.session.remove(slot);
      await browser.alarms.clear(this.alarm(slot));
    });
  }

  static async flushPassphrase() {
    const slot = await this.slot();
    return navigator.locks.request(slot, () => browser.storage.session.remove(slot));
  }

  static async _clearFlushAlarms() {
    return browser.alarms.clear(this.alarm(await this.slot()));
  }

  static async handleFlushEvent(alarm) {
    if (alarm.name === PASSPHRASE_FLUSH_ALARM) {
      await this.flush(null);
    } else if (alarm.name.startsWith(`${PASSPHRASE_FLUSH_ALARM}:passphrase:`)) {
      const slot = alarm.name.slice(`${PASSPHRASE_FLUSH_ALARM}:`.length);
      // A delayed alarm from an earlier unlock must not destroy a refreshed session.
      await navigator.locks.request(slot, async () => {
        const data = (await browser.storage.session.get(slot))[slot];
        if (data?.expires !== null && data?.expires <= Date.now()) {
          await browser.storage.session.remove(slot);
        }
      });
    }
  }

  /**
   * Returns the PASSPHRASE_FLUSH_ALARM name
   * @returns {string}
   */
  static get ALARM_NAME() {
    return PASSPHRASE_FLUSH_ALARM;
  }
}

export default PassphraseStorageService;
