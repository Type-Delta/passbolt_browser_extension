import { v4 as uuidv4 } from "uuid";
import PendingAccountSessionStorage from "./pendingAccountSessionStorage";
import MfaAuthenticationRequiredError from "../../error/mfaAuthenticationRequiredError";
import SavedAccountRegistry from "./savedAccountRegistry";
import AccountContext from "./accountContext";
import AccountEntity from "../../model/entity/account/accountEntity";
import AccountModel from "../../model/account/accountModel";
import { OpenpgpAssertion } from "../../utils/openpgp/openpgpAssertions";
import DecryptPrivateKeyService from "../crypto/decryptPrivateKeyService";
import AuthVerifyServerKeyService from "../api/auth/authVerifyServerKeyService";
import AuthVerifyServerChallengeService from "../auth/authVerifyServerChallengeService";
import AuthVerifyLoginChallengeService from "../auth/authVerifyLoginChallengeService";
import AuthLogoutService from "passbolt-styleguide/src/shared/services/api/auth/AuthLogoutService";
import { ApiClientOptions } from "passbolt-styleguide/src/shared/lib/apiClient/apiClientOptions";
import { findAuthenticatedUser, assertAuthenticatedAccount } from "./accountApiGuard";
import PassphraseStorageService from "../session_storage/passphraseStorageService";
import ResourceLocalStorage from "../local_storage/resourceLocalStorage";
import FolderLocalStorage from "../local_storage/folderLocalStorage";
import UserLocalStorage from "../local_storage/userLocalStorage";
import RolesLocalStorage from "../local_storage/rolesLocalStorage";
import PasswordGeneratorLocalStorage from "../local_storage/passwordGeneratorLocalStorage";
import SiteSettingsRuntimeCache from "../siteSettings/siteSettingsRuntimeCache";
import resourceInProgressCacheService from "../cache/resourceInProgressCache.service";
import KeepSessionAliveService from "../session_storage/keepSessionAliveService";
import StartLoopAuthSessionCheckService from "../auth/startLoopAuthSessionCheckService";
import OfflineSessionExpiryAlarmService from "../auth/offlineSessionExpiryAlarmService";
import CopyToClipboardService from "../clipboard/copyToClipboardService";
import PortManager from "../../sdk/port/portManager";
import WorkersSessionStorage from "../sessionStorage/workersSessionStorage";
import SsoKitTemporaryStorageService from "../session_storage/ssoKitTemporaryStorageService";
import WebauthnSetupCeremonySessionStorageService from "../sessionStorage/webauthnSetupCeremonySessionStorageService";
import MetadataKeysSessionStorage from "../session_storage/metadataKeysSessionStorage";
import SessionKeysBundlesSessionStorageService from "../sessionStorage/sessionKeysBundlesSessionStorageService";
import SsoDataStorage from "../indexedDB_storage/ssoDataStorage";
import ActiveSessionLocalStorage from "../local_storage/activeSessionLocalStorage";
import PostLoginService from "../auth/postLoginService";
import Keyring from "../../model/keyring";
import toolbarService from "../toolbar/toolbarService";
import User from "../../model/user";
import { Config } from "../../model/config";

class SavedAccountsService {
  static navigationContexts = new WeakMap();
  static options(domain) {
    return new ApiClientOptions().setBaseUrl(domain);
  }

  static async list(port) {
    // Listing remains available during a network outage; identity failures never save the pending key.
    await this.reconcilePending(port).catch(() => null);
    const pending = await this.pending();
    const state = await SavedAccountRegistry.read();
    const accounts = await Promise.all(
      state.accounts.map(async (dto) => {
        const account = SavedAccountRegistry.account(dto);
        return {
          id: account.id,
          domain: account.domain,
          username: account.username,
          first_name: account.firstName,
          last_name: account.lastName,
          is_locked: !(await PassphraseStorageService.get(account.id)),
        };
      }),
    );
    const suggestion = accounts.length === 0 ? await this.suggestedServer() : null;
    return {
      active_account_id: state.active_account_id,
      accounts,
      pending: pending
        ? { domain: pending.account.domain, username: pending.account.username, expires_at: pending.expires }
        : null,
      servers: [...new Set([...accounts.map((account) => account.domain), ...(suggestion ? [suggestion] : [])])].map(
        (domain) => ({ domain }),
      ),
    };
  }

  static async suggestedServer() {
    const [tab] = (await browser.tabs.query({ active: true, currentWindow: true })) || [];
    if (!tab?.url) {
      return null;
    }
    try {
      const page = new URL(tab.url);
      if (!/\/(?:app|auth|mfa)(?:\/|$)/.test(page.pathname)) {
        return null;
      }
      const path = page.pathname.replace(/\/(?:app|auth|mfa)(?:\/.*)?$/, "");
      const domain = SavedAccountRegistry.canonicalDomain(`${page.origin}${path}`);
      // The current tab is only a hint after it proves to be a Passbolt API. Never list arbitrary sites.
      const key = await new AuthVerifyServerKeyService(this.options(domain)).getServerKey();
      await OpenpgpAssertion.readKeyOrFail(key.armored_key);
      return domain;
    } catch {
      return null;
    }
  }

  static async clearWorkingState() {
    toolbarService.tabUrl = null;
    await Promise.all([
      ResourceLocalStorage.flush(),
      FolderLocalStorage.flush(),
      UserLocalStorage.flush(),
      RolesLocalStorage.flush(),
      PasswordGeneratorLocalStorage.flush(),
      SsoKitTemporaryStorageService.flush(),
      WebauthnSetupCeremonySessionStorageService.flush(),
      browser.storage.session.remove("resourceInProgress"),
      KeepSessionAliveService.stop(),
      StartLoopAuthSessionCheckService.clearAlarm(),
      OfflineSessionExpiryAlarmService.clearAlarm(),
      new CopyToClipboardService().flushTemporaryContentIfAny(),
    ]);
    SiteSettingsRuntimeCache.flushAll();
    resourceInProgressCacheService.reset();
    User.getInstance().setCsrfToken(null);
  }

  static async invalidateWorkers(initiatingPort) {
    // The initiating port survives just long enough to return the public result.
    for (const port of Object.values(PortManager._ports)) {
      if (port !== initiatingPort) {
        port.disconnect();
      }
    }
    await WorkersSessionStorage.flush();
  }

  static async verifyServer(account) {
    await new AuthVerifyServerChallengeService(this.options(account.domain)).verifyAndValidateServerChallenge(
      account.userKeyFingerprint,
      account.serverPublicArmoredKey,
    );
  }

  static async authenticate(account, passphrase) {
    const options = this.options(account.domain);
    // Do not let GPGAuth's "already authenticated" shortcut accept another user's cookie.
    await new AuthLogoutService(options).logout();
    await this.verifyServer(account);
    const provisionalUser = await new AuthVerifyLoginChallengeService(options).verifyAndValidateLoginChallenge(
      account.userKeyFingerprint,
      account.userPrivateArmoredKey,
      passphrase,
    );
    this.assertIdentity(provisionalUser, account.username, account.userKeyFingerprint);
    if (provisionalUser.id !== account.userId) {
      throw new Error("The server returned another authenticated identity.");
    }
    await assertAuthenticatedAccount(options, account, { checkMfa: true });
  }

  /** Restore only the retained foreground's existing unlock and verified cookie context. */
  static async resumeForegroundMaintenance(accountId) {
    try {
      const account = await SavedAccountRegistry.active();
      if (account.id !== accountId || !(await PassphraseStorageService.get(accountId))) {
        return;
      }
      await assertAuthenticatedAccount(this.options(account.domain), account, { checkMfa: true });
      if ((await SavedAccountRegistry.active()).id !== accountId || !(await PassphraseStorageService.get(accountId))) {
        return;
      }
      await StartLoopAuthSessionCheckService.clearAlarm();
      await StartLoopAuthSessionCheckService.exec();
      await KeepSessionAliveService.resume(accountId);
    } catch {
      // A replaced/unverifiable cookie must not let maintenance sign out and erase the retained unlock.
      const state = await SavedAccountRegistry.read();
      if (state.active_account_id === accountId) {
        await Promise.all([KeepSessionAliveService.stop(), StartLoopAuthSessionCheckService.clearAlarm()]);
      }
    }
  }

  static async transition(port, operation, targetAccountId, expectedPending) {
    const result = await AccountContext.transition(async () => {
      if (expectedPending) {
        const current = await this.pending();
        if (!current || current.attempt_id !== expectedPending.attempt_id) {
          return null;
        }
      }
      const state = await SavedAccountRegistry.read();
      const snapshot = JSON.parse(JSON.stringify(state));
      if (!expectedPending) {
        await this.cancelPending();
      }
      const previous = state.accounts
        .map((dto) => SavedAccountRegistry.account(dto))
        .find((account) => account.id === state.active_account_id);
      const changesForeground = !targetAccountId || state.active_account_id === targetAccountId;
      if (changesForeground) {
        AccountContext.generation++;
        await this.invalidateWorkers(port);
        await this.clearWorkingState();
      }
      let selected = false;
      try {
        const result = await operation(state);
        selected = result?.requires_unlock === false;
        if (result?.url) {
          this.navigationContexts.set(result, {
            ...this.navigationContexts.get(result),
            generation: AccountContext.generation,
          });
        }
        return result;
      } catch (error) {
        // Restore encrypted foreground state and selection. Cookie identity remains checked on every request.
        if (changesForeground) {
          if (previous) {
            await new AccountModel().activate(previous);
          } else {
            this.clearProjection();
          }
        }
        await SavedAccountRegistry.write(snapshot);
        if (changesForeground) {
          await this.clearWorkingState();
        }
        throw error;
      } finally {
        if (changesForeground && previous && !selected) {
          await this.resumeForegroundMaintenance(previous.id);
        }
      }
    }, false);
    if (result?.requires_unlock === false) {
      await toolbarService.handleUserLoggedIn();
    }
    return result;
  }

  static async select(account, state) {
    const passphrase = await PassphraseStorageService.get(account.id);
    let requiresUnlock = !passphrase;
    if (passphrase) {
      try {
        await assertAuthenticatedAccount(this.options(account.domain), account);
      } catch {
        // A remembered local unlock never bypasses server expiration, key proof or MFA.
        try {
          await this.authenticate(account, passphrase);
        } catch (authenticationError) {
          if (!(authenticationError instanceof MfaAuthenticationRequiredError)) {
            throw authenticationError;
          }
          // Saved accounts already have a verified identity, but still need server MFA again.
          const pending = await this.savePending(account, passphrase, true);
          return this.pendingResult(account, pending);
        }
      }
      requiresUnlock = false;
    } else {
      // A locked selection must not inherit another identity's server session.
      await new AuthLogoutService(this.options(account.domain)).logout();
    }
    await new AccountModel().activate(account);
    state.active_account_id = account.id;
    await SavedAccountRegistry.write(state);
    if (!requiresUnlock) {
      await PostLoginService.exec(account, this.options(account.domain));
      await KeepSessionAliveService.resume(account.id);
    }
    return {
      account_id: account.id,
      url: `${account.domain}/${requiresUnlock ? "auth/login" : "app/passwords"}`,
      requires_unlock: requiresUnlock,
    };
  }

  static async switch(accountId, port) {
    return this.transition(port, async (state) => {
      const account = state.accounts
        .map((dto) => SavedAccountRegistry.account(dto))
        .find((account) => account.id === accountId);
      if (!account) {
        throw new Error("The saved account does not exist.");
      }
      return this.select(account, state);
    });
  }

  static async add(input, port) {
    const domain = SavedAccountRegistry.canonicalDomain(input.domain);
    if (typeof input.username !== "string" || typeof input.passphrase !== "string") {
      throw new Error("An email and passphrase are required.");
    }
    const privateKey = await OpenpgpAssertion.readKeyOrFail(input.user_private_armored_key);
    OpenpgpAssertion.assertPrivateKey(privateKey);
    if (privateKey.isDecrypted()) {
      throw new Error("Import an encrypted private key.");
    }
    await DecryptPrivateKeyService.decrypt(privateKey, input.passphrase);
    const fingerprint = privateKey.getFingerprint().toUpperCase();
    return this.transition(port, async (state) => {
      const options = this.options(domain);
      const serverKey = await new AuthVerifyServerKeyService(options).getServerKey();
      const downloadedKey = await OpenpgpAssertion.readKeyOrFail(serverKey.armored_key);
      const pinned = state.accounts.find((dto) => dto.domain === domain);
      if (pinned) {
        const pinnedKey = await OpenpgpAssertion.readKeyOrFail(pinned.server_public_armored_key);
        if (pinnedKey.getFingerprint() !== downloadedKey.getFingerprint()) {
          throw new Error("The saved server key changed. Verify the server before adding another account.");
        }
      }
      // Discovery initializes the target's CSRF cookie before its first logout.
      await new AuthLogoutService(options).logout();
      await new AuthVerifyServerChallengeService(options).verifyAndValidateServerChallenge(
        fingerprint,
        serverKey.armored_key,
      );
      const provisionalUser = await new AuthVerifyLoginChallengeService(options).verifyAndValidateLoginChallenge(
        fingerprint,
        input.user_private_armored_key,
        input.passphrase,
      );
      this.assertIdentity(provisionalUser, input.username, fingerprint);
      let user;
      try {
        user = await findAuthenticatedUser(options, { checkMfa: true });
      } catch (error) {
        if (!(error instanceof MfaAuthenticationRequiredError)) {
          throw error;
        }
      }
      if (user) {
        this.assertIdentity(user, input.username, fingerprint);
        if (user.id !== provisionalUser.id) {
          throw new Error("The authenticated identity changed during enrollment.");
        }
      }
      const requiresMfa = !user;
      user = user || provisionalUser;
      const account = new AccountEntity({
        domain,
        user_id: user.id,
        username: user.username,
        first_name: user.profile.first_name,
        last_name: user.profile.last_name,
        user_key_fingerprint: fingerprint,
        user_public_armored_key: privateKey.toPublic().armor(),
        user_private_armored_key: input.user_private_armored_key,
        server_public_armored_key: serverKey.armored_key,
        security_token: input.security_token || { code: "PB1", color: "#000000", textcolor: "#ffffff" },
      });
      if (requiresMfa) {
        const pending = await this.savePending(account, input.passphrase, false);
        return this.pendingResult(account, pending);
      }
      state.accounts = state.accounts.filter((dto) => SavedAccountRegistry.account(dto).id !== account.id);
      state.accounts.push(account.toDto(AccountEntity.ALL_CONTAIN_OPTIONS));
      await PassphraseStorageService.set(input.passphrase, 60, account.id);
      return this.select(account, state);
    });
  }

  static assertIdentity(user, username, fingerprint) {
    if (
      !user?.id ||
      user.username?.toLowerCase() !== username.trim().toLowerCase() ||
      user.gpgkey?.fingerprint?.toUpperCase() !== fingerprint
    ) {
      throw new Error("The authenticated account does not match the email and imported key.");
    }
  }

  static pendingResult(account, pending) {
    const result = { account_id: account.id, url: `${account.domain}/mfa/verify/totp`, requires_unlock: true };
    this.navigationContexts.set(result, { pending, generation: AccountContext.generation });
    return result;
  }

  static async savePending(account, passphrase, saved) {
    const pending = {
      attempt_id: uuidv4(),
      account: account.toDto(AccountEntity.ALL_CONTAIN_OPTIONS),
      passphrase,
      saved,
      expires: Date.now() + 5 * 60 * 1000,
      tab_id: null,
    };
    await PendingAccountSessionStorage.change(null, async () => {
      await browser.storage.session.set({ pending_account: pending });
      await browser.alarms.clear("PendingAccountExpiry");
      await browser.alarms.create("PendingAccountExpiry", { when: pending.expires });
    });
    return pending;
  }

  static pending() {
    return PendingAccountSessionStorage.read();
  }

  static cancelPending(expected) {
    return PendingAccountSessionStorage.remove(expected);
  }

  /** Explicit cancellation may sign out only a freshly verified matching cookie. */
  static async cancelPendingSignIn(port) {
    return AccountContext.transition(async () => {
      const state = await SavedAccountRegistry.read();
      const pending = await this.pending();
      try {
        if (pending) {
          const account = SavedAccountRegistry.account(pending.account);
          // An incomplete factor or an unreachable server cannot prove cookie ownership.
          await assertAuthenticatedAccount(this.options(account.domain), account);
          await new AuthLogoutService(this.options(account.domain)).logout();
        }
      } catch {
        // Cancel always erases local material, without claiming an unverifiable server signout.
      } finally {
        if (pending) {
          await this.cancelPending(pending);
        }
        if (state.active_account_id) {
          await this.resumeForegroundMaintenance(state.active_account_id);
        }
      }
      return this.list(port);
    }, false);
  }

  static async reconcilePending(port, expected) {
    if (AccountContext.transitioning) {
      return null;
    }
    const pending = await this.pending();
    if (!pending || pending.tab_id === null || (expected && pending.attempt_id !== expected.attempt_id)) {
      return null;
    }
    const account = SavedAccountRegistry.account(pending.account);
    try {
      const user = await assertAuthenticatedAccount(this.options(account.domain), account, { checkMfa: true });
      this.assertIdentity(user, account.username, account.userKeyFingerprint);
    } catch (error) {
      if (error instanceof MfaAuthenticationRequiredError) {
        return null;
      }
      if (error.name === "AccountIdentityMismatchError") {
        await this.cancelPending(pending);
      }
      throw error;
    }
    // Recheck after the foreground drain, then serialize the final local commit with cancellation.
    return this.transition(
      port,
      async (state) => {
        try {
          await assertAuthenticatedAccount(this.options(account.domain), account, { checkMfa: true });
        } catch (error) {
          if (error.name === "AccountIdentityMismatchError") {
            await this.cancelPending(pending);
          }
          throw error;
        }
        const committed = await PendingAccountSessionStorage.change(pending, async () => {
          state.accounts = state.accounts.filter((dto) => SavedAccountRegistry.account(dto).id !== account.id);
          state.accounts.push(account.toDto(AccountEntity.ALL_CONTAIN_OPTIONS));
          if (!pending.saved) {
            await PassphraseStorageService.set(pending.passphrase, 60, account.id);
          }
          await new AccountModel().activate(account);
          state.active_account_id = account.id;
          await SavedAccountRegistry.write(state);
          await browser.storage.session.remove("pending_account");
          await browser.alarms.clear("PendingAccountExpiry");
          return true;
        });
        if (!committed) {
          return null;
        }
        await PostLoginService.exec(account, this.options(account.domain));
        await KeepSessionAliveService.resume(account.id);
        return { account_id: account.id, url: `${account.domain}/app/passwords`, requires_unlock: false };
      },
      undefined,
      pending,
    );
  }

  /** Native server MFA owns factor entry; bind only the created tab and never inject vault handlers into it. */
  static async onPendingNavigation(details) {
    const pending = await this.pending();
    if (!pending || pending.tab_id !== details.tabId || (details.frameId !== undefined && details.frameId !== 0)) {
      return false;
    }
    const account = SavedAccountRegistry.account(pending.account);
    const page = new URL(details.url);
    const base = new URL(account.domain);
    if (
      page.origin !== base.origin ||
      !(page.pathname === base.pathname || page.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`))
    ) {
      await this.cancelPending(pending);
      return true;
    }
    const result = await this.reconcilePending(undefined, pending);
    if (result) {
      await this.navigate(result, { tab: { id: details.tabId } });
      await this.publishChanged();
    }
    return true;
  }

  static async lock(accountId, port) {
    return this.transition(
      port,
      async (state) => {
        if (!state.accounts.some((dto) => SavedAccountRegistry.account(dto).id === accountId)) {
          throw new Error("The saved account does not exist.");
        }
        await PassphraseStorageService.flush(accountId);
        const accountToLock = state.accounts
          .map((dto) => SavedAccountRegistry.account(dto))
          .find((account) => account.id === accountId);
        await Promise.all([
          new MetadataKeysSessionStorage(accountToLock).flush(),
          new ActiveSessionLocalStorage(accountToLock).flush(),
          new SessionKeysBundlesSessionStorageService(accountToLock).flush(),
        ]);
        if (state.active_account_id === accountId) {
          const account = state.accounts
            .map((dto) => SavedAccountRegistry.account(dto))
            .find((account) => account.id === accountId);
          await new AuthLogoutService(this.options(account.domain)).logout();
          const tabs = await browser.tabs.query({});
          const base = new URL(account.domain);
          for (const tab of tabs) {
            if (!tab.url) {
              continue;
            }
            const page = new URL(tab.url);
            const appPath = `${base.pathname.replace(/\/$/, "")}/app`;
            if (page.origin === base.origin && (page.pathname === appPath || page.pathname.startsWith(`${appPath}/`))) {
              await browser.tabs.update(tab.id, { url: `${account.domain}/auth/login` });
            }
          }
        }
        return this.list();
      },
      accountId,
    );
  }

  static clearProjection() {
    const keyring = new Keyring();
    keyring.flush(Keyring.PRIVATE);
    keyring.flush(Keyring.PUBLIC);
    for (const key of Object.keys(Config.readAll()).filter((key) => key.startsWith("user."))) {
      Config.write(key, null);
    }
  }

  static async remove(accountId, port) {
    return this.transition(
      port,
      async (state) => {
        const account = state.accounts
          .map((dto) => SavedAccountRegistry.account(dto))
          .find((account) => account.id === accountId);
        if (!account) {
          throw new Error("The saved account does not exist.");
        }
        if (state.active_account_id === accountId) {
          await new AuthLogoutService(this.options(account.domain)).logout();
        }
        await PassphraseStorageService.flush(accountId);
        await SsoDataStorage.flush(accountId);
        await Promise.all([
          new MetadataKeysSessionStorage(account).flush(),
          new SessionKeysBundlesSessionStorageService(account).flush(),
          new ActiveSessionLocalStorage(account).flush(),
        ]);
        for (const area of [browser.storage.local, browser.storage.session]) {
          const keys = Object.keys(await area.get(null)).filter(
            (key) => key.endsWith(`-${accountId}`) || key.endsWith(`:${accountId}`),
          );
          await area.remove(keys);
        }
        state.accounts = state.accounts.filter((dto) => SavedAccountRegistry.account(dto).id !== accountId);
        if (state.active_account_id === accountId) {
          state.active_account_id = null;
          this.clearProjection();
        }
        await SavedAccountRegistry.write(state);
        return this.list();
      },
      accountId,
    );
  }

  static async publishChanged() {
    const summary = await this.list();
    const extensionUrl = browser.runtime.getURL("/");
    for (const port of Object.values(PortManager._ports)) {
      if (port._port.sender?.url?.startsWith(extensionUrl)) {
        // A closed popup must never interrupt native handoff or notifications to other ports.
        await port.emitQuiet("passbolt.accounts.changed", summary).catch(() => {});
      }
    }
  }

  static async navigate(result, worker) {
    const context = this.navigationContexts.get(result);
    const generation = context?.generation ?? AccountContext.generation;
    AccountContext.assert(generation);
    const isMfa = result.url.endsWith("/mfa/verify/totp");
    const pending = isMfa ? context?.pending || (await this.pending()) : null;
    AccountContext.assert(generation);
    if (isMfa && (!pending || SavedAccountRegistry.account(pending.account).id !== result.account_id)) {
      throw new Error("The account sign-in was canceled. Try again.");
    }
    if (pending) {
      // Tab creation is outside the lock. Only this attempt can bind or navigate its reservation.
      const ownsTab = worker.tab?.id === undefined;
      const tab = ownsTab ? await browser.tabs.create({ url: "about:blank" }) : worker.tab;
      if (tab?.id === undefined) {
        throw new Error("The MFA tab could not be opened. Cancel the sign-in and try again.");
      }
      let navigation;
      try {
        const bound = await PendingAccountSessionStorage.change(pending, async (current) => {
          AccountContext.assert(generation);
          current.tab_id = tab.id;
          await browser.storage.session.set({ pending_account: current });
          AccountContext.assert(generation);
          // Start the browser IPC while authorized; await completion after releasing the mutation lock.
          navigation = Promise.resolve(browser.tabs.update(tab.id, { url: result.url }));
          // Observe immediate rejection while the storage lock is being released.
          navigation.catch(() => {});
          return true;
        });
        if (!bound) {
          throw new Error("The account sign-in was canceled. Try again.");
        }
        await navigation;
        const completed = await PendingAccountSessionStorage.change(pending, (current) => {
          AccountContext.assert(generation);
          return current.tab_id === tab.id;
        });
        if (!completed) {
          throw new Error("The account sign-in was canceled. Try again.");
        }
      } catch (error) {
        const reserved = ownsTab ? await browser.tabs.get(tab.id).catch(() => null) : null;
        const native = new URL(result.url);
        const page = reserved?.url ? new URL(reserved.url) : null;
        const canClose =
          page && (page.href === "about:blank" || (page.origin === native.origin && page.pathname === native.pathname));
        let removal;
        await PendingAccountSessionStorage.change(null, async (current) => {
          if (current?.attempt_id === pending.attempt_id && current.tab_id === tab.id) {
            current.tab_id = null;
            await browser.storage.session.set({ pending_account: current });
          }
          if (canClose && current?.tab_id !== tab.id) {
            // A replacement may reuse the tab. Serialize ownership checking and starting cleanup with binding.
            removal = Promise.resolve(browser.tabs.remove(tab.id));
            removal.catch(() => {});
          }
        });
        await removal?.catch(() => {});
        throw error;
      }
    } else if (worker.tab?.id !== undefined) {
      await browser.tabs.update(worker.tab.id, { url: result.url });
      AccountContext.assert(generation);
    } else {
      await browser.tabs.create({ url: result.url });
      AccountContext.assert(generation);
    }
  }
}

export default SavedAccountsService;
