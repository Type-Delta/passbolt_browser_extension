import ReplaceServerKeyController from "../../controller/auth/replaceServerKeyController";
import MfaAuthenticationRequiredError from "../../error/mfaAuthenticationRequiredError";
import SavedAccountRegistry from "./savedAccountRegistry";
import SavedAccountsService from "./savedAccountsService";
import AccountContext from "./accountContext";
import AccountEntity from "../../model/entity/account/accountEntity";
import AccountModel from "../../model/account/accountModel";
import { defaultAccountDto, adminAccountDto } from "../../model/entity/account/accountEntity.test.data";
import MockExtension from "../../../../../test/mocks/mockExtension";
import { OpenpgpAssertion } from "../../utils/openpgp/openpgpAssertions";
import Keyring from "../../model/keyring";
import PassphraseStorageService from "../session_storage/passphraseStorageService";
import SsoDataStorage from "../indexedDB_storage/ssoDataStorage";
import toolbarService from "../toolbar/toolbarService";
import PostLoginService from "../auth/postLoginService";
import AuthLogoutService from "passbolt-styleguide/src/shared/services/api/auth/AuthLogoutService";
import { findAuthenticatedUser, assertAuthenticatedAccount } from "./accountApiGuard";
import AuthVerifyLoginChallengeService from "../auth/authVerifyLoginChallengeService";
import AuthVerifyServerChallengeService from "../auth/authVerifyServerChallengeService";
import AuthVerifyServerKeyService from "../api/auth/authVerifyServerKeyService";
import PortManager from "../../sdk/port/portManager";
import WorkerEntity from "../../model/entity/worker/workerEntity";
import { readWorker } from "../../model/entity/worker/workerEntity.test.data";
import ResourceLocalStorage from "../local_storage/resourceLocalStorage";
import MetadataKeysSessionStorage from "../session_storage/metadataKeysSessionStorage";
import SessionKeysBundlesSessionStorageService from "../sessionStorage/sessionKeysBundlesSessionStorageService";
import KeepSessionAliveService from "../session_storage/keepSessionAliveService";
import SavedServerRegistry from "./savedServerRegistry";
import { pgpKeys } from "passbolt-styleguide/test/fixture/pgpKeys/keys";

jest.mock("./accountApiGuard", () => ({ assertAuthenticatedAccount: jest.fn(), findAuthenticatedUser: jest.fn() }));

afterEach(async () => {
  for (const alarm of await browser.alarms.getAll()) {
    await browser.alarms.clear(alarm.name);
  }
});

beforeEach(() => {
  jest.restoreAllMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
  assertAuthenticatedAccount.mockReset().mockResolvedValue({});
  jest.spyOn(PostLoginService, "exec").mockResolvedValue();
  jest.spyOn(toolbarService, "handleUserLoggedIn").mockResolvedValue();
  jest.spyOn(SsoDataStorage, "flush").mockResolvedValue();
  jest.spyOn(AuthLogoutService.prototype, "logout").mockResolvedValue();
  jest.spyOn(browser.tabs, "get").mockImplementation(async (id) => ({ id, url: "about:blank" }));
});

it("migrates configured encrypted keys once and preserves all identities when projecting another account", async () => {
  await MockExtension.withConfiguredAccount();
  const originalKey = new Keyring().findPrivate().armoredKey;
  const state = await SavedAccountRegistry.read();
  expect(state.accounts[0].user_private_armored_key).toBe(originalKey);
  const second = new AccountEntity(adminAccountDto());
  await SavedAccountRegistry.save(second);
  await SavedAccountsService.switch(second.id);
  const saved = await SavedAccountRegistry.read();
  expect(saved.accounts).toHaveLength(2);
  expect(saved.accounts[0].user_private_armored_key).toBe(originalKey);
  const expectedFingerprint = (await OpenpgpAssertion.readKeyOrFail(second.userPrivateArmoredKey))
    .getFingerprint()
    .toUpperCase();
  expect(new Keyring().findPrivate().fingerprint.toUpperCase()).toBe(expectedFingerprint);
  expect((await SavedAccountRegistry.active()).id).toBe(second.id);
});

it("does not collide on repeated server UUIDs or email across canonical deployments", async () => {
  const a = await SavedAccountRegistry.save(
    new AccountEntity(defaultAccountDto({ domain: "https://EXAMPLE.test:443/team/" })),
    true,
  );
  const b = await SavedAccountRegistry.save(
    new AccountEntity(defaultAccountDto({ domain: "https://example.test/other" })),
  );
  const c = await SavedAccountRegistry.save(
    new AccountEntity(adminAccountDto({ domain: a.domain, username: a.username })),
  );
  expect(a.domain).toBe("https://example.test/team");
  expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  expect((await SavedAccountRegistry.read()).accounts).toHaveLength(3);
  expect(() => SavedAccountRegistry.canonicalDomain("https://user:password@example.test")).toThrow();
  expect(() => SavedAccountRegistry.canonicalDomain("http://example.test")).toThrow();
});

it("fails closed on partial legacy migration without overwriting its encrypted keyring", async () => {
  await MockExtension.withConfiguredAccount();
  new Keyring().flush(Keyring.PUBLIC);
  const key = new Keyring().findPrivate().armoredKey;
  await expect(SavedAccountRegistry.read()).rejects.toThrow();
  expect((await browser.storage.local.get("saved-accounts-v1"))["saved-accounts-v1"]).toBeUndefined();
  expect(new Keyring().findPrivate().armoredKey).toBe(key);
});

it("reuses separate unlock sessions through A to B to A without extending either deadline", async () => {
  const a = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  const b = await SavedAccountRegistry.save(new AccountEntity(adminAccountDto({ domain: "https://b.test" })));
  await PassphraseStorageService.set("a", 60, a.id);
  await PassphraseStorageService.set("b", 120, b.id);
  const before = await browser.storage.session.get(null);
  expect((await SavedAccountsService.switch(b.id)).requires_unlock).toBe(false);
  expect((await SavedAccountsService.switch(a.id)).requires_unlock).toBe(false);
  const after = await browser.storage.session.get(null);
  expect(after[`passphrase:${a.id}`]).toEqual(before[`passphrase:${a.id}`]);
  expect(after[`passphrase:${b.id}`]).toEqual(before[`passphrase:${b.id}`]);
  expect(new Keyring().findPrivate().fingerprint.toUpperCase() === a.userKeyFingerprint).toBe(true);
  expect(AuthLogoutService.prototype.logout).not.toHaveBeenCalled();
});

it("rejects post-factor navigation while a newer switch drains the committed account's toolbar work", async () => {
  const a = new AccountEntity(defaultAccountDto({ domain: "https://a.test" }));
  const b = await SavedAccountRegistry.save(new AccountEntity(adminAccountDto({ domain: "https://b.test" })), true);
  await new AccountModel().activate(b);
  await PassphraseStorageService.set("b", 60, b.id);
  assertAuthenticatedAccount.mockImplementation(async (options, account) => ({
    id: account.userId,
    username: account.username,
    gpgkey: { fingerprint: account.userKeyFingerprint },
  }));
  await SavedAccountsService.savePending(a, "a", false);
  const pending = await SavedAccountsService.pending();
  pending.tab_id = 42;
  await browser.storage.session.set({ pending_account: pending });
  let badgeStarted, releaseBadge;
  const started = new Promise((resolve) => {
    badgeStarted = resolve;
  });
  const badge = new Promise((resolve) => {
    releaseBadge = resolve;
  });
  toolbarService.handleUserLoggedIn.mockImplementationOnce(() =>
    AccountContext.run(AccountContext.generation, async () => {
      badgeStarted();
      await badge;
    }),
  );
  const updateTab = jest.spyOn(browser.tabs, "update");
  const navigation = SavedAccountsService.onPendingNavigation({
    tabId: 42,
    frameId: 0,
    url: `${a.domain}/app/passwords`,
  }).catch((error) => error);
  await started;
  const switching = SavedAccountsService.switch(b.id);
  expect(AccountContext.transitioning).toBe(true);
  releaseBadge();

  const [outcome] = await Promise.all([navigation, switching]);

  expect(outcome).toBeInstanceOf(Error);
  expect(updateTab).not.toHaveBeenCalled();
  expect((await SavedAccountRegistry.active()).id).toBe(b.id);
});

it("expires inactive slots on read even if the browser alarm has not run and ignores delayed old alarms", async () => {
  await PassphraseStorageService.set("a", 10, "a");
  await PassphraseStorageService.set("b", 20, "b");
  const slot = (await browser.storage.session.get("passphrase:a"))["passphrase:a"];
  slot.expires = Date.now() - 1;
  await browser.storage.session.set({ "passphrase:a": slot });
  expect(await PassphraseStorageService.get("a")).toBeNull();
  expect(await PassphraseStorageService.get("b")).toBe("b");
  await PassphraseStorageService.set("new-a", 30, "a");
  await PassphraseStorageService.handleFlushEvent({ name: "PassphraseStorageFlush:passphrase:a" });
  expect(await PassphraseStorageService.get("a")).toBe("new-a");
  await PassphraseStorageService.flush("a");
  expect(await PassphraseStorageService.get("b")).toBe("b");
});

it("drains a late old-account cache write before clearing caches and rejects stale handlers", async () => {
  const account = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  let finishResponse;
  const response = new Promise((resolve) => {
    finishResponse = resolve;
  });
  const old = AccountContext.run(0, async () => {
    await response;
    await browser.storage.local.set({ resources: [{ id: "old-account" }] });
    ResourceLocalStorage._cachedData = [{ id: "old-account" }];
  });
  const switching = SavedAccountsService.switch(account.id);
  expect(AccountContext.transitioning).toBe(true);
  await expect(AccountContext.run(0, () => {})).rejects.toThrow();
  finishResponse();
  await old;
  await switching;
  expect(await ResourceLocalStorage.get()).toBeUndefined();
  await expect(AccountContext.run(0, () => {})).rejects.toThrow();
});

it("rolls back registry and encrypted projection after partial target activation fails", async () => {
  const a = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  const b = await SavedAccountRegistry.save(new AccountEntity(adminAccountDto()));
  await new AccountModel().activate(a);
  const activate = AccountModel.prototype.activate;
  jest
    .spyOn(AccountModel.prototype, "activate")
    .mockImplementationOnce(async function (account) {
      await activate.call(this, account);
      throw new Error("simulated storage failure");
    })
    .mockImplementation(activate);
  await expect(SavedAccountsService.switch(b.id)).rejects.toThrow("simulated storage failure");
  expect((await SavedAccountRegistry.active()).id).toBe(a.id);
  expect(new Keyring().findPrivate().fingerprint.toUpperCase() === a.userKeyFingerprint).toBe(true);
  expect((await SavedAccountRegistry.read()).accounts).toHaveLength(2);
  expect(AccountContext.transitioning).toBe(false);
});

it("keeps MFA pending keys session-only, expires them and never exposes them in summaries", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "session-only", false);
  assertAuthenticatedAccount.mockRejectedValue(new MfaAuthenticationRequiredError());
  expect((await SavedAccountsService.list()).accounts).toEqual([]);
  expect(JSON.stringify(await browser.storage.local.get(null))).not.toContain(account.userPrivateArmoredKey);
  const pending = await SavedAccountsService.pending();
  pending.expires = Date.now() - 1;
  await browser.storage.session.set({ pending_account: pending });
  expect(await SavedAccountsService.pending()).toBeNull();
  expect((await browser.storage.session.get("pending_account")).pending_account).toBeUndefined();
});

it("does not resurrect a removed account from the legacy keyring", async () => {
  const a = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  await new AccountModel().activate(a);
  await SavedAccountsService.remove(a.id);
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
  expect(new Keyring().findPrivate()).toBeUndefined();
});

it("commits pending MFA only after exact post-MFA UUID, email and fingerprint proof", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountRegistry.read();
  await SavedAccountsService.savePending(account, "session-only", false);
  await SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    { tab: { id: 42 } },
  );
  assertAuthenticatedAccount.mockResolvedValue({
    id: account.userId,
    username: account.username,
    gpgkey: { fingerprint: account.userKeyFingerprint },
  });
  const result = await SavedAccountsService.reconcilePending();
  expect(result.account_id).toBe(account.id);
  expect(result.requires_unlock).toBe(false);
  expect((await SavedAccountRegistry.active()).id).toBe(account.id);
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect(await PassphraseStorageService.get(account.id)).toBe("session-only");
});

it("binds pending MFA to its exact tab and canonical backend path without attaching another tab", async () => {
  const account = new AccountEntity(defaultAccountDto({ domain: "https://server.test/team" }));
  await SavedAccountsService.savePending(account, "session-only", false);
  const pending = await SavedAccountsService.pending();
  pending.tab_id = 42;
  await browser.storage.session.set({ pending_account: pending });
  assertAuthenticatedAccount.mockRejectedValue(new MfaAuthenticationRequiredError());
  expect(
    await SavedAccountsService.onPendingNavigation({ tabId: 41, url: "https://server.test/team/mfa/verify/totp" }),
  ).toBe(false);
  expect(
    await SavedAccountsService.onPendingNavigation({ tabId: 42, url: "https://server.test/team/mfa/verify/totp" }),
  ).toBe(true);
  expect(await SavedAccountsService.pending()).toBeDefined();
  expect(
    await SavedAccountsService.onPendingNavigation({ tabId: 42, url: "https://server.test/team-evil/mfa/verify/totp" }),
  ).toBe(true);
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
});

it("erases pending material without saving if the post-MFA cookie changes to another identity", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "session-only", false);
  await SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    { tab: { id: 42 } },
  );
  assertAuthenticatedAccount.mockRejectedValue(
    Object.assign(new Error("wrong identity"), { name: "AccountIdentityMismatchError" }),
  );
  await expect(SavedAccountsService.reconcilePending()).rejects.toThrow("wrong identity");
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
});

it("migrates the original legacy unlock deadline without renewing it", async () => {
  await MockExtension.withConfiguredAccount();
  const deadline = Date.now() + 15000;
  await browser.storage.session.set({ passphrase: "legacy-session" });
  await browser.alarms.create("PassphraseStorageFlush", { when: deadline });
  const state = await SavedAccountRegistry.read();
  const slot = (await browser.storage.session.get(`passphrase:${state.active_account_id}`))[
    `passphrase:${state.active_account_id}`
  ];
  expect(slot).toEqual({ passphrase: "legacy-session", expires: deadline });
  expect((await browser.storage.session.get("passphrase")).passphrase).toBeUndefined();
});

function enrollmentFixture() {
  const dto = defaultAccountDto();
  const user = {
    id: dto.user_id,
    username: dto.username,
    profile: { first_name: dto.first_name, last_name: dto.last_name },
    gpgkey: { fingerprint: dto.user_key_fingerprint },
  };
  jest
    .spyOn(AuthVerifyServerKeyService.prototype, "getServerKey")
    .mockResolvedValue({ armored_key: dto.server_public_armored_key });
  jest.spyOn(AuthVerifyServerChallengeService.prototype, "verifyAndValidateServerChallenge").mockResolvedValue();
  jest.spyOn(AuthVerifyLoginChallengeService.prototype, "verifyAndValidateLoginChallenge").mockResolvedValue(user);
  return {
    user,
    input: {
      domain: dto.domain,
      username: dto.username,
      user_private_armored_key: dto.user_private_armored_key,
      passphrase: "ada@passbolt.com",
    },
  };
}

it("enrolls an encrypted key only after stock-API key proof and exact resolved user identity", async () => {
  const { user, input } = enrollmentFixture();
  findAuthenticatedUser.mockResolvedValue(user);
  const result = await SavedAccountsService.add(input);
  const account = await SavedAccountRegistry.active();
  expect(result.account_id).toBe(account.id);
  expect(result.requires_unlock).toBe(false);
  expect(account.userPrivateArmoredKey === input.user_private_armored_key).toBe(true);
  const summary = await SavedAccountsService.list();
  expect(Object.keys(summary.accounts[0]).sort()).toEqual([
    "domain",
    "first_name",
    "id",
    "is_locked",
    "last_name",
    "username",
  ]);
  expect(AuthLogoutService.prototype.logout).toHaveBeenCalledTimes(1);
  expect(AuthVerifyServerChallengeService.prototype.verifyAndValidateServerChallenge).toHaveBeenCalledTimes(1);
});

it("requires a chosen token before onboarding can begin account authentication", async () => {
  const { input } = enrollmentFixture();
  await expect(SavedAccountsService.add(input, undefined, { onboarding: true })).rejects.toThrow();
  expect(AuthLogoutService.prototype.logout).not.toHaveBeenCalled();
});

it("saves the chosen security token after a verified onboarding import", async () => {
  const { user, input } = enrollmentFixture();
  findAuthenticatedUser.mockResolvedValue(user);
  await SavedServerRegistry.remember({
    domain: input.domain,
    server_key_fingerprint: pgpKeys.server.fingerprint,
    checked_at: Date.now(),
  });
  const token = { code: "CUS", color: "#123456", textcolor: "#ffffff" };
  const result = await SavedAccountsService.add(
    { ...input, security_token: token, expected_server_key_fingerprint: pgpKeys.server.fingerprint },
    undefined,
    { onboarding: true },
  );
  expect(result.requires_unlock).toBe(false);
  expect((await SavedAccountRegistry.active()).securityToken.toDto()).toEqual(token);
});

it("requires an explicitly verified server before the new flow can authenticate", async () => {
  const { input } = enrollmentFixture();
  await expect(
    SavedAccountsService.add(
      {
        ...input,
        security_token: { code: "CUS", color: "#123456", textcolor: "#ffffff" },
        expected_server_key_fingerprint: pgpKeys.server.fingerprint,
      },
      undefined,
      { onboarding: true },
    ),
  ).rejects.toThrow("Verify the server");
  expect(AuthLogoutService.prototype.logout).not.toHaveBeenCalled();
});

it("rejects a changed preflight fingerprint before logout or GPGAuth challenges", async () => {
  const { user, input } = enrollmentFixture();
  findAuthenticatedUser.mockResolvedValue(user);
  await SavedServerRegistry.remember({
    domain: input.domain,
    server_key_fingerprint: pgpKeys.server.fingerprint,
    checked_at: Date.now(),
  });
  AuthVerifyServerKeyService.prototype.getServerKey.mockResolvedValue({ armored_key: pgpKeys.ada.public });
  await expect(
    SavedAccountsService.add(
      {
        ...input,
        security_token: { code: "CUS", color: "#123456", textcolor: "#ffffff" },
        expected_server_key_fingerprint: pgpKeys.server.fingerprint,
      },
      undefined,
      { onboarding: true },
    ),
  ).rejects.toThrow("server key changed");
  expect(AuthLogoutService.prototype.logout).not.toHaveBeenCalled();
  expect(AuthVerifyServerChallengeService.prototype.verifyAndValidateServerChallenge).not.toHaveBeenCalled();
});

it("retains a server when its last account is removed before any account list was opened", async () => {
  const account = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()));
  const list = await SavedAccountsService.remove(account.id);
  expect(list.accounts).toEqual([]);
  expect(list.servers).toContainEqual({ domain: account.domain });
});

it("enrolls a newly visited backend after discovery initializes its CSRF cookie", async () => {
  const { user, input } = enrollmentFixture();
  const dto = defaultAccountDto();
  let csrfReady = false;
  AuthVerifyServerKeyService.prototype.getServerKey.mockImplementation(async () => {
    csrfReady = true;
    return { armored_key: dto.server_public_armored_key };
  });
  AuthLogoutService.prototype.logout.mockImplementation(async () => {
    if (!csrfReady) {
      throw new Error("Missing or incorrect CSRF cookie.");
    }
  });
  findAuthenticatedUser.mockResolvedValue(user);

  const result = await SavedAccountsService.add(input);

  expect(result.requires_unlock).toBe(false);
  expect((await SavedAccountRegistry.active()).username).toBe(user.username);
});

it("a successful GPGAuth pending-MFA enrollment never projects its private key or persists a record", async () => {
  const { input } = enrollmentFixture();
  findAuthenticatedUser.mockRejectedValue(new MfaAuthenticationRequiredError());
  const result = await SavedAccountsService.add(input);
  expect(result.requires_unlock).toBe(true);
  expect(result.url).toBe(`${input.domain}/mfa/verify/totp`);
  expect(new Keyring().findPrivate()).toBeUndefined();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
  expect(
    (await SavedAccountsService.pending()).account.user_private_armored_key === input.user_private_armored_key,
  ).toBe(true);
  expect((await browser.storage.local.get(null)).pending_account).toBeUndefined();
});

it("refuses enrollment when the server-resolved email differs despite matching key fingerprint", async () => {
  const { user, input } = enrollmentFixture();
  findAuthenticatedUser.mockResolvedValue({ ...user, username: "another@example.test" });
  await expect(SavedAccountsService.add(input)).rejects.toThrow("does not match");
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
  expect(new Keyring().findPrivate()).toBeUndefined();
});

it("rejects stale workers, different origins and sibling paths even when tab and frame identifiers match", async () => {
  const account = await SavedAccountRegistry.save(
    new AccountEntity(defaultAccountDto({ domain: "https://server.test/team" })),
    true,
  );
  const worker = new WorkerEntity({ ...readWorker(), name: "App", account_id: account.id });
  const sender = {
    frameId: worker.frameId,
    tab: { id: worker.tabId, url: "https://server.test/team/app/passwords" },
    url: browser.runtime.getURL("/webAccessibleResources/passbolt-iframe-app.html"),
  };
  expect(await PortManager.isKnownPortSender(worker, sender)).toBe(true);
  expect(await PortManager.isKnownPortSender(worker, { ...sender, url: "https://evil.test/team/app/passwords" })).toBe(
    false,
  );
  expect(
    await PortManager.isKnownPortSender(worker, {
      ...sender,
      tab: { ...sender.tab, url: "https://server.test/team-evil/app/passwords" },
    }),
  ).toBe(false);
  const stale = new WorkerEntity({ ...worker.toDto(), account_id: "old-account" });
  expect(await PortManager.isKnownPortSender(stale, sender)).toBe(false);
});

it("erases pending enrollment when its owned MFA tab is closed", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "session-only", false);
  const pending = await SavedAccountsService.pending();
  pending.tab_id = 42;
  await browser.storage.session.set({ pending_account: pending });
  await PortManager.onTabRemoved(42, { windowId: 1, isWindowClosing: false });
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
});

it("locking an inactive account preserves the foreground generation and the other unlock slot", async () => {
  const a = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  const b = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto({ domain: "https://b.test" })));
  await new AccountModel().activate(a);
  await PassphraseStorageService.set("a", 60, a.id);
  await PassphraseStorageService.set("b", 60, b.id);
  await SavedAccountsService.lock(b.id);
  expect(AccountContext.generation).toBe(0);
  expect((await SavedAccountRegistry.active()).id).toBe(a.id);
  expect(await PassphraseStorageService.get(a.id)).toBe("a");
  expect(await PassphraseStorageService.get(b.id)).toBeNull();
  expect(AuthLogoutService.prototype.logout).not.toHaveBeenCalled();
});

it("posts logout before removing the active record and preserves it if signout fails", async () => {
  const account = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  await new AccountModel().activate(account);
  AuthLogoutService.prototype.logout.mockImplementation(async () => {
    expect((await SavedAccountRegistry.active()).id).toBe(account.id);
    throw new Error("unreachable signout");
  });
  await expect(SavedAccountsService.remove(account.id)).rejects.toThrow("unreachable signout");
  expect((await SavedAccountRegistry.active()).id).toBe(account.id);
});

it("removing an inactive same-backend identity never signs out the foreground user", async () => {
  const a = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  const b = await SavedAccountRegistry.save(new AccountEntity(adminAccountDto({ domain: a.domain })));
  await SavedAccountsService.remove(b.id);
  expect(AuthLogoutService.prototype.logout).not.toHaveBeenCalled();
  expect((await SavedAccountRegistry.active()).id).toBe(a.id);
});

it("updates every same-backend server pin in one registry write after confirmed replacement", async () => {
  const a = await SavedAccountRegistry.save(
    new AccountEntity(defaultAccountDto({ domain: "https://server.test/team" })),
    true,
  );
  const b = await SavedAccountRegistry.save(new AccountEntity(adminAccountDto({ domain: a.domain })));
  const c = await SavedAccountRegistry.save(
    new AccountEntity(defaultAccountDto({ domain: "https://server.test/other" })),
  );
  const write = jest.spyOn(SavedAccountRegistry, "write");
  const key = adminAccountDto().user_public_armored_key;
  await SavedAccountRegistry.replaceServerKey("https://SERVER.test:443/team/", key);
  const state = await SavedAccountRegistry.read();
  expect(write).toHaveBeenCalledTimes(1);
  for (const dto of state.accounts) {
    expect(dto.server_public_armored_key).toBe(dto.domain === a.domain ? key : c.serverPublicArmoredKey);
  }
  expect(state.active_account_id).toBe(a.id);
  expect(state.accounts.map((dto) => SavedAccountRegistry.account(dto).id)).toEqual([a.id, b.id, c.id]);
});

it("returns only the public pending summary and never reconciles an unbound handoff", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "session-only", false);
  const summary = await SavedAccountsService.list();
  expect(summary.pending).toEqual({
    domain: account.domain,
    username: account.username,
    expires_at: expect.any(Number),
  });
  expect(summary.accounts).toEqual([]);
  expect(assertAuthenticatedAccount).not.toHaveBeenCalled();
});

it.each(["matching", "changed", "unreachable"])(
  "explicit cancel erases session material and signs out only verified pending identity: %s",
  async (status) => {
    const account = new AccountEntity(defaultAccountDto());
    await SavedAccountsService.savePending(account, "session-only", false);
    if (status !== "matching") {
      assertAuthenticatedAccount.mockRejectedValue(new Error(status));
    }
    const result = await SavedAccountsService.cancelPendingSignIn();
    expect(result.pending).toBeNull();
    expect(await SavedAccountsService.pending()).toBeUndefined();
    expect(AuthLogoutService.prototype.logout).toHaveBeenCalledTimes(status === "matching" ? 1 : 0);
    expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
    await expect(SavedAccountsService.cancelPendingSignIn()).resolves.toEqual(result);
  },
);
it("cancel still erases local pending secrets if verified logout fails", async () => {
  await SavedAccountsService.savePending(new AccountEntity(defaultAccountDto()), "session-only", false);
  AuthLogoutService.prototype.logout.mockRejectedValue(new Error("unreachable"));
  expect((await SavedAccountsService.cancelPendingSignIn()).pending).toBeNull();
  expect(await browser.alarms.get("PendingAccountExpiry")).toBeNull();
});
it("does not save a canceled pending attempt when a late identity lookup returns", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "session-only", false);
  await SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    { tab: { id: 42 } },
  );
  let finish;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  assertAuthenticatedAccount.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const reconcile = SavedAccountsService.reconcilePending();
  await ready;
  await SavedAccountsService.cancelPending();
  finish({ id: account.userId, username: account.username, gpgkey: { fingerprint: account.userKeyFingerprint } });
  await expect(reconcile).resolves.toBeNull();
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
});
it("keeps bound pending material and the public list usable during a readiness network outage", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "session-only", false);
  await SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    { tab: { id: 42 } },
  );
  assertAuthenticatedAccount.mockRejectedValue(new Error("unreachable"));
  const result = await SavedAccountsService.list();
  expect(result.pending.username).toBe(account.username);
  expect(result.accounts).toEqual([]);
  expect(await SavedAccountsService.pending()).toBeDefined();
});
it("publishes changes to other ports after one popup disconnected", async () => {
  const closed = {
    _port: { sender: { url: browser.runtime.getURL("/webAccessibleResources/quickaccess.html") } },
    emitQuiet: jest.fn().mockRejectedValue(new Error("closed")),
  };
  const live = { ...closed, emitQuiet: jest.fn().mockResolvedValue() };
  const previous = PortManager._ports;
  PortManager._ports = { closed, live };
  try {
    await expect(SavedAccountsService.publishChanged()).resolves.toBeUndefined();
    expect(live.emitQuiet).toHaveBeenCalledWith(
      "passbolt.accounts.changed",
      expect.objectContaining({ pending: null }),
    );
  } finally {
    PortManager._ports = previous;
  }
});
it("navigates only active account vault tabs to the trusted login after lock", async () => {
  const account = await SavedAccountRegistry.save(
    new AccountEntity(defaultAccountDto({ domain: "https://server.test/team" })),
    true,
  );
  jest.spyOn(browser.tabs, "query").mockResolvedValue([
    { id: 42, url: `${account.domain}/app/passwords` },
    { id: 43, url: "https://server.test/team-evil/app/passwords" },
    { id: 44, url: "https://foreign.test/team/app/passwords" },
  ]);
  const update = jest.spyOn(browser.tabs, "update").mockClear();
  await SavedAccountsService.lock(account.id);
  expect(update).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith(42, { url: `${account.domain}/auth/login` });
});

it("confirmed replacement controller persists the downloaded server key for sibling accounts", async () => {
  const account = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  const sibling = await SavedAccountRegistry.save(new AccountEntity(adminAccountDto({ domain: account.domain })));
  const key = adminAccountDto().user_public_armored_key;
  jest.spyOn(AuthVerifyServerKeyService.prototype, "getServerKey").mockResolvedValue({ armored_key: key });
  await new ReplaceServerKeyController({}, "request", SavedAccountsService.options(account.domain), account).exec();
  const state = await SavedAccountRegistry.read();
  expect(state.accounts.every((dto) => dto.server_public_armored_key === key)).toBe(true);
  expect(
    SavedAccountRegistry.account(state.accounts.find((dto) => dto.user_id === sibling.userId)).serverPublicArmoredKey,
  ).toBe(key);
});

function deferred() {
  let finish, fail;
  const promise = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { promise, resolve: finish, reject: fail };
}
it("never resurrects canceled material after a late blank-tab reservation", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "session-only", false);
  const created = deferred(),
    started = deferred();
  jest.spyOn(browser.tabs, "create").mockImplementation(() => {
    started.resolve();
    return created.promise;
  });
  const update = jest.spyOn(browser.tabs, "update").mockClear();
  const remove = jest.spyOn(browser.tabs, "remove").mockResolvedValue();
  const navigation = SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    {},
  );
  const outcome = navigation.catch((error) => error);
  await started.promise;
  expect((await SavedAccountsService.cancelPendingSignIn()).pending).toBeNull();
  created.resolve({ id: 99 });
  expect(await outcome).toBeInstanceOf(Error);
  expect(await SavedAccountsService.pending()).toBeUndefined();
  expect(update).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith(99);
});
it("an older identity mismatch cannot erase a replacement pending attempt", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "old", false);
  await SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    { tab: { id: 42 } },
  );
  const identity = deferred(),
    started = deferred();
  assertAuthenticatedAccount.mockImplementationOnce(() => {
    started.resolve();
    return identity.promise;
  });
  const reconciling = SavedAccountsService.reconcilePending().catch((error) => error);
  await started.promise;
  await SavedAccountsService.savePending(account, "replacement", false);
  const replacement = await SavedAccountsService.pending();
  identity.reject(Object.assign(new Error("changed"), { name: "AccountIdentityMismatchError" }));
  await reconciling;
  expect(await SavedAccountsService.pending()).toEqual(replacement);
});
it("forgets removed crypto through real runtime getters and preserves the other account", async () => {
  const a = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  const b = await SavedAccountRegistry.save(new AccountEntity(adminAccountDto()));
  const stores = [MetadataKeysSessionStorage, SessionKeysBundlesSessionStorageService];
  for (const Store of stores) {
    const removed = new Store(b),
      kept = new Store(a);
    await browser.storage.session.set({
      [removed.storageKey]: [{ synthetic: "removed" }],
      [kept.storageKey]: [{ synthetic: "kept" }],
    });
    expect(await removed.get()).toEqual([{ synthetic: "removed" }]);
    await kept.get();
  }
  await SavedAccountsService.remove(b.id);
  for (const Store of stores) {
    expect(await new Store(b).get()).toBeUndefined();
    expect((await browser.storage.session.get(null))[new Store(b).storageKey]).toBeUndefined();
    expect(await new Store(a).get()).toEqual([{ synthetic: "kept" }]);
  }
  await SavedAccountRegistry.save(b);
  for (const Store of stores) {
    expect(await new Store(b).get()).toBeUndefined();
  }
});
it.each([-1, 60])("restores keepalive only for a selected remembered slot, duration %s", async (duration) => {
  const a = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  const b = await SavedAccountRegistry.save(new AccountEntity(adminAccountDto()));
  await PassphraseStorageService.set("b", duration, b.id);
  const before = await browser.storage.session.get(`passphrase:${b.id}`);
  await KeepSessionAliveService.start();
  await SavedAccountsService.switch(b.id);
  expect(await KeepSessionAliveService.isStarted()).toBe(duration === -1);
  expect(await browser.storage.session.get(`passphrase:${b.id}`)).toEqual(before);
  expect((await SavedAccountRegistry.active()).id).toBe(b.id);
  expect(a.id).not.toBe(b.id);
});

it("checks the attempt again at final local commit after the foreground drain and fresh network proof", async () => {
  const account = new AccountEntity(defaultAccountDto());
  const replacement = new AccountEntity(adminAccountDto());
  const user = { id: account.userId, username: account.username, gpgkey: { fingerprint: account.userKeyFingerprint } };
  await SavedAccountsService.savePending(account, "old", false);
  await SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    { tab: { id: 42 } },
  );
  const identity = deferred(),
    started = deferred();
  assertAuthenticatedAccount.mockResolvedValueOnce(user).mockImplementationOnce(() => {
    started.resolve();
    return identity.promise;
  });
  const reconciling = SavedAccountsService.reconcilePending();
  await started.promise;
  await SavedAccountsService.cancelPending();
  await SavedAccountsService.savePending(replacement, "new", false);
  const current = await SavedAccountsService.pending();
  identity.resolve(user);
  expect(await reconciling).toBeNull();
  expect(await SavedAccountsService.pending()).toEqual(current);
  expect((await SavedAccountRegistry.read()).accounts).toEqual([]);
  expect(new Keyring().findPrivate()).toBeUndefined();
});
it("an older navigation failure cannot reset or erase a replacement binding", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "old", false);
  const updated = deferred(),
    started = deferred();
  jest.spyOn(browser.tabs, "create").mockResolvedValue({ id: 42 });
  jest.spyOn(browser.tabs, "update").mockImplementationOnce(() => {
    started.resolve();
    return updated.promise;
  });
  const navigating = SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    {},
  ).catch((error) => error);
  await started.promise;
  await SavedAccountsService.savePending(account, "replacement", false);
  const replacement = await SavedAccountsService.pending();
  updated.reject(new Error("late IPC failure"));
  expect(await navigating).toBeInstanceOf(Error);
  expect(await SavedAccountsService.pending()).toEqual(replacement);
});
it("accepts the exact backend base path without a trailing slash while pending", async () => {
  const account = new AccountEntity(defaultAccountDto({ domain: "https://server.test/team" }));
  await SavedAccountsService.savePending(account, "pending", false);
  await SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    { tab: { id: 42 } },
  );
  assertAuthenticatedAccount.mockRejectedValue(new MfaAuthenticationRequiredError());
  expect(await SavedAccountsService.onPendingNavigation({ tabId: 42, frameId: 0, url: account.domain })).toBe(true);
  expect(await SavedAccountsService.pending()).toBeDefined();
});
it("a stale internal handoff result cannot bind a newer attempt for the same account", async () => {
  const account = new AccountEntity(defaultAccountDto());
  const first = await SavedAccountsService.savePending(account, "old", false);
  const result = SavedAccountsService.pendingResult(account, first);
  await SavedAccountsService.savePending(account, "new", false);
  jest.spyOn(browser.tabs, "create").mockResolvedValue({ id: 42 });
  const update = jest.spyOn(browser.tabs, "update").mockClear();
  const current = await SavedAccountsService.pending();
  await expect(SavedAccountsService.navigate(result, {})).rejects.toThrow("canceled");
  expect(await SavedAccountsService.pending()).toEqual(current);
  expect(update).not.toHaveBeenCalled();
});

it("serializes cancellation with an already-authorized but delayed pending write", async () => {
  const account = new AccountEntity(defaultAccountDto());
  await SavedAccountsService.savePending(account, "old", false);
  const writing = deferred(),
    release = deferred();
  const set = browser.storage.session.set.bind(browser.storage.session);
  jest.spyOn(browser.storage.session, "set").mockImplementation(async (data) => {
    if (data.pending_account?.tab_id === 42) {
      writing.resolve();
      await release.promise;
    }
    return set(data);
  });
  jest.spyOn(browser.tabs, "create").mockResolvedValue({ id: 42 });
  const navigation = SavedAccountsService.navigate(
    { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
    {},
  ).catch((error) => error);
  await writing.promise;
  let canceled = false;
  const cancellation = SavedAccountsService.cancelPendingSignIn().then((result) => {
    canceled = true;
    return result;
  });
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  const canceledBeforeWrite = canceled;
  release.resolve();
  expect(await navigation).toBeInstanceOf(Error);
  expect((await cancellation).pending).toBeNull();
  expect(canceledBeforeWrite).toBe(false);
  expect(await SavedAccountsService.pending()).toBeUndefined();
});

it.each([false, true])(
  "a mismatch in the fresh final proof cleans only that attempt, replaced=%s",
  async (replaced) => {
    const account = new AccountEntity(defaultAccountDto());
    const user = {
      id: account.userId,
      username: account.username,
      gpgkey: { fingerprint: account.userKeyFingerprint },
    };
    await SavedAccountsService.savePending(account, "old", false);
    await SavedAccountsService.navigate(
      { account_id: account.id, url: `${account.domain}/mfa/verify/totp` },
      { tab: { id: 42 } },
    );
    const identity = deferred(),
      started = deferred();
    assertAuthenticatedAccount.mockResolvedValueOnce(user).mockImplementationOnce(() => {
      started.resolve();
      return identity.promise;
    });
    const reconciling = SavedAccountsService.reconcilePending().catch((error) => error);
    await started.promise;
    if (replaced) {
      await SavedAccountsService.savePending(account, "replacement", false);
    }
    identity.reject(Object.assign(new Error("changed cookie"), { name: "AccountIdentityMismatchError" }));
    expect(await reconciling).toBeInstanceOf(Error);
    const current = await SavedAccountsService.pending();
    if (replaced) {
      expect(current.passphrase).toBe("replacement");
    } else {
      expect(current).toBeUndefined();
    }
  },
);

it("a late ordinary switch result cannot bind or navigate a newer pending attempt", async () => {
  const a = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  const b = await SavedAccountRegistry.save(new AccountEntity(adminAccountDto()));
  const oldResult = await SavedAccountsService.switch(a.id);
  await SavedAccountsService.switch(b.id);
  await SavedAccountsService.savePending(b, "new attempt", true);
  const current = await SavedAccountsService.pending();
  const update = jest.spyOn(browser.tabs, "update").mockClear();
  await expect(SavedAccountsService.navigate(oldResult, { tab: { id: 42 } })).rejects.toThrow(
    "selected account changed",
  );
  expect(update).not.toHaveBeenCalled();
  expect(await SavedAccountsService.pending()).toEqual(current);
});
