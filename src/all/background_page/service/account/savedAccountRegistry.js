import { OpenpgpAssertion } from "../../utils/openpgp/openpgpAssertions";
import AccountEntity from "../../model/entity/account/accountEntity";
import GetLegacyAccountService from "./getLegacyAccountService";
import User from "../../model/user";
import storage from "../../sdk/storage";
import { Config } from "../../model/config";

const STORAGE_KEY = "saved-accounts-v1";

/** Encrypted account records. Only explicit public summaries may cross a port. */
class SavedAccountRegistry {
  static canonicalDomain(domain) {
    const url = new URL(domain);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTPS server base URL without credentials, query or fragment.");
    }
    return url.href.replace(/\/+$/, "");
  }

  static async normalize(account) {
    const privateKey = await OpenpgpAssertion.readKeyOrFail(account.userPrivateArmoredKey);
    const publicKey = await OpenpgpAssertion.readKeyOrFail(account.userPublicArmoredKey);
    OpenpgpAssertion.assertPrivateKey(privateKey);
    if (privateKey.isDecrypted() || privateKey.getFingerprint() !== publicKey.getFingerprint()) {
      throw new Error("Only an encrypted matching private key can be saved.");
    }
    return new AccountEntity(
      {
        ...account.toDto(AccountEntity.ALL_CONTAIN_OPTIONS),
        domain: this.canonicalDomain(account.domain),
        user_key_fingerprint: privateKey.getFingerprint().toUpperCase(),
      },
      { validateUsername: false },
    );
  }

  static async read() {
    return navigator.locks.request(STORAGE_KEY, async () => {
      const stored = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (stored) {
        if (stored.version !== 1 || !Array.isArray(stored.accounts)) {
          throw new Error("Invalid saved-account registry. Existing keys have been preserved.");
        }
        return stored;
      }
      if (Object.keys(storage._data).length === 0) {
        await storage.init();
        Config.init();
      }
      const state = { version: 1, active_account_id: null, accounts: [] };
      if (User.getInstance().isValid()) {
        // Fail closed on a broken configured keyring. Never overwrite it with an empty registry.
        const account = await this.normalize(GetLegacyAccountService.get());
        state.accounts.push(account.toDto(AccountEntity.ALL_CONTAIN_OPTIONS));
        state.active_account_id = account.id;
        state.legacy_account_id = account.id;
        const legacy = (await browser.storage.session.get("passphrase")).passphrase;
        if (legacy) {
          const alarm = await browser.alarms.get("PassphraseStorageFlush");
          const session =
            typeof legacy === "string" ? { passphrase: legacy, expires: alarm?.scheduledTime ?? null } : legacy;
          if (session.expires === null || session.expires > Date.now()) {
            await browser.storage.session.set({ [`passphrase:${account.id}`]: session });
            if (session.expires !== null) {
              await browser.alarms.create(`PassphraseStorageFlush:passphrase:${account.id}`, { when: session.expires });
            }
          }
          await browser.storage.session.remove("passphrase");
          await browser.alarms.clear("PassphraseStorageFlush");
        }
      }
      await browser.storage.local.set({ [STORAGE_KEY]: state });
      return state;
    });
  }

  static async write(state) {
    await browser.storage.local.set({ [STORAGE_KEY]: state });
  }

  static account(dto) {
    return new AccountEntity(dto, { validateUsername: false });
  }

  static async active() {
    const state = await this.read();
    const account = state.accounts
      .map((dto) => this.account(dto))
      .find((account) => account.id === state.active_account_id);
    if (!account) {
      throw new Error("No active saved account.");
    }
    return account;
  }

  static async save(account, activate = false) {
    const normalized = await this.normalize(account);
    await this.read();
    await navigator.locks.request(STORAGE_KEY, async () => {
      const state = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      state.accounts = state.accounts.filter((dto) => this.account(dto).id !== normalized.id);
      state.accounts.push(normalized.toDto(AccountEntity.ALL_CONTAIN_OPTIONS));
      if (activate) {
        state.active_account_id = normalized.id;
      }
      await this.write(state);
    });
    return normalized;
  }

  /** Called only after the user confirms replacement of this server's trusted key. */
  static async replaceServerKey(domain, armoredKey) {
    const canonical = this.canonicalDomain(domain);
    await OpenpgpAssertion.readKeyOrFail(armoredKey);
    await this.read();
    await navigator.locks.request(STORAGE_KEY, async () => {
      const state = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      state.accounts = state.accounts.map((dto) =>
        this.canonicalDomain(dto.domain) === canonical ? { ...dto, server_public_armored_key: armoredKey } : dto,
      );
      await this.write(state);
    });
  }
}

export default SavedAccountRegistry;
