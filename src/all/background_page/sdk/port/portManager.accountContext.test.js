/**
 * Passbolt ~ Open source password manager for teams
 * Copyright (c) Passbolt SA (https://www.passbolt.com)
 *
 * Licensed under GNU Affero General Public License version 3 of the or any later version.
 * For full copyright and license information, please see the LICENSE.txt
 * Redistributions of files must retain the above copyright notice.
 */
import PortManager from "./portManager";
import SavedAccountRegistry from "../../service/account/savedAccountRegistry";
import WebIntegration from "../../pagemod/webIntegrationPagemod";
import MockExtension from "../../../../../test/mocks/mockExtension";
import AccountEntity from "../../model/entity/account/accountEntity";
import WorkersSessionStorage from "../../service/sessionStorage/workersSessionStorage";
import WorkerEntity from "../../model/entity/worker/workerEntity";
import { readWorker } from "../../model/entity/worker/workerEntity.test.data";

let worker, sender;

beforeEach(async () => {
  // Chrome normalizes leading slashes in getURL; the stock test adapter leaves a double slash.
  browser.runtime.getURL.mockImplementation(
    (path) => `chrome-extension://didegimhafipceonhjepacocaffmoppf/${path.replace(/^\/+/, "")}`,
  );
  await MockExtension.withConfiguredAccount();
  const account = await SavedAccountRegistry.active();
  worker = new WorkerEntity(readWorker({ name: "WebIntegration", tabId: 17, frameId: 0, account_id: account.id }));
  sender = {
    tab: { id: 17, url: "http://login.example.test/signin" },
    url: "http://login.example.test/signin",
    frameId: 0,
  };
});

it("connects the active account's content script on an eligible third-party login", async () => {
  expect(await WebIntegration.canBeAttachedTo({ url: sender.url, frameId: 0 })).toBe(true);
  expect(await PortManager.isKnownPortSender(worker, sender)).toBe(true);
});

it("retains account, tab and frame restrictions outside the backend", async () => {
  expect(
    await PortManager.isKnownPortSender(new WorkerEntity({ ...worker.toDto(), account_id: "stale-account" }), sender),
  ).toBe(false);
  expect(await PortManager.isKnownPortSender(worker, { ...sender, tab: { ...sender.tab, id: 18 } })).toBe(false);
  expect(await PortManager.isKnownPortSender(worker, { ...sender, frameId: 2 })).toBe(false);
});

it("continues to reject a vault iframe hosted on the third-party site", async () => {
  expect(await PortManager.isKnownPortSender(new WorkerEntity({ ...worker.toDto(), name: "App" }), sender)).toBe(false);
});

it("denies a Quick Access iframe on a hostile host but accepts the popup and a top-level extension tab", async () => {
  const url = browser.runtime.getURL("/webAccessibleResources/quickaccess.html?passbolt=quickaccess");
  expect(await PortManager.isAccountManagementSender("QuickAccess", { url, frameId: 4, tab: sender.tab })).toBe(false);
  expect(await PortManager.isAccountManagementSender("QuickAccess", { url })).toBe(true);
  expect(await PortManager.isAccountManagementSender("QuickAccess", { url, frameId: 0, tab: { id: 20, url } })).toBe(
    true,
  );
});
it("accepts actual ExtApp on the selected backend with a bound nonzero frame, rejects other pages and roles", async () => {
  const account = await SavedAccountRegistry.active();
  const app = new WorkerEntity({ ...worker.toDto(), name: "App", frameId: 3 });
  await WorkersSessionStorage.addWorker(app);
  const frame = {
    url: browser.runtime.getURL("/webAccessibleResources/passbolt-iframe-app.html"),
    tab: { id: app.tabId, url: `${account.domain}/app/passwords` },
    frameId: 3,
  };
  expect(await PortManager.isAccountManagementSender("App", frame, app.id)).toBe(true);
  for (const bad of [
    { ...frame, url: browser.runtime.getURL("/webAccessibleResources/quickaccess.html") },
    { ...frame, url: browser.runtime.getURL("/webAccessibleResources/passbolt-iframe-app.html.evil") },
    { ...frame, frameId: 4 },
    { ...frame, tab: { ...frame.tab, id: 999 } },
    { ...frame, tab: { ...frame.tab, url: "https://evil.test/app/passwords" } },
  ]) {
    expect(await PortManager.isAccountManagementSender("App", bad, app.id)).toBe(false);
  }
  expect(await PortManager.isAccountManagementSender("Auth", frame, app.id)).toBe(false);
});
it("excludes inactive saved backends from third-party integration while ordinary external sites remain eligible", async () => {
  const account = await SavedAccountRegistry.active();
  await SavedAccountRegistry.save(
    new AccountEntity({ ...account.toDto(AccountEntity.ALL_CONTAIN_OPTIONS), domain: "https://other.test/team" }),
  );
  expect(await WebIntegration.canBeAttachedTo({ url: "https://other.test/team/app/passwords", frameId: 0 })).toBe(
    false,
  );
  expect(await WebIntegration.canBeAttachedTo({ url: sender.url, frameId: 0 })).toBe(true);
});

it("authorizes the real detached Quick Access producer with an active account and exact sender binding", async () => {
  const { QuickAccessService } = await import("../../service/ui/quickAccess.service");
  const create = jest.spyOn(browser.windows, "create").mockResolvedValue({ id: 9, tabs: [{ id: 91 }] });
  browser.windows.getCurrent = jest.fn(async () => ({ top: 0, left: 0, width: 1200 }));
  browser.windows.update = jest.fn();
  await QuickAccessService.openInDetachedMode([{ name: "feature", value: "request-passphrase" }]);
  const url = create.mock.calls[0][0].url;
  const id = new URL(url).searchParams.get("passbolt");
  const dto = await WorkersSessionStorage.getWorkerById(id);
  const detached = { url, frameId: 0, tab: { id: 91, url } };
  expect(dto.account_id).toBe((await SavedAccountRegistry.active()).id);
  expect(await PortManager.isKnownPortSender(new WorkerEntity(dto), detached)).toBe(true);
  expect(await PortManager.isAccountManagementSender("QuickAccess", detached, id)).toBe(true);
  for (const bad of [
    { ...detached, frameId: 2 },
    { ...detached, url: browser.runtime.getURL("/webAccessibleResources/quickaccess.html?passbolt=other") },
    { ...detached, tab: { id: 91, url: "https://evil.test" } },
    { ...detached, tab: { id: 92, url } },
  ]) {
    expect(await PortManager.isKnownPortSender(new WorkerEntity(dto), bad)).toBe(false);
    expect(await PortManager.isAccountManagementSender("QuickAccess", bad, id)).toBe(false);
  }
});
