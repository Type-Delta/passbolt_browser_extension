import { enableFetchMocks } from "jest-fetch-mock";
import { ApiClient } from "passbolt-styleguide/src/shared/lib/apiClient/apiClient";
import AccountEntity from "../../model/entity/account/accountEntity";
import { defaultAccountDto } from "../../model/entity/account/accountEntity.test.data";
import BuildApiClientOptionsService from "./buildApiClientOptionsService";
import AccountContext from "./accountContext";
import { v4 as uuid } from "uuid";

beforeEach(() => {
  enableFetchMocks();
  fetch.resetMocks();
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  AccountContext.running.clear();
});

function client() {
  const account = new AccountEntity(defaultAccountDto({ domain: "https://server.test/team" }));
  const options = BuildApiClientOptionsService.buildFromAccount(account).setResourceName("resources");
  return { api: new ApiClient(options), account };
}

function identity(account) {
  return JSON.stringify({
    body: { id: account.userId, username: account.username, gpgkey: { fingerprint: account.userKeyFingerprint } },
  });
}

it("rejects a same-server cookie belonging to another user before issuing a resource mutation", async () => {
  const { api, account } = client();
  fetch.mockResponseOnce(
    identity({
      ...account,
      userId: uuid(),
      username: account.username,
      userKeyFingerprint: account.userKeyFingerprint,
    }),
  );
  await expect(api.create({ name: "private" })).rejects.toThrow("another account");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toContain("/team/users/me.json");
});

it("checks the registered fingerprint even when UUID and email match", async () => {
  const { api, account } = client();
  fetch.mockResponseOnce(
    JSON.stringify({
      body: { id: account.userId, username: account.username, gpgkey: { fingerprint: "0".repeat(40) } },
    }),
  );
  await expect(api.findAll()).rejects.toThrow("another account");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("never sends account credentials to a different origin or a sibling deployment path", async () => {
  const { api } = client();
  await expect(api.sendRequest("POST", new URL("https://other.test/team/resources.json"), "{}")).rejects.toThrow(
    "base URL",
  );
  await expect(api.sendRequest("POST", new URL("https://server.test/team-evil/resources.json"), "{}")).rejects.toThrow(
    "base URL",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("uses redirect:error on identity and data requests so credentials cannot follow a redirect", async () => {
  const { api, account } = client();
  fetch.mockResponseOnce(identity(account));
  fetch.mockResponseOnce(JSON.stringify({ body: [] }));
  await expect(api.findAll()).resolves.toEqual({ body: [] });
  expect(fetch.mock.calls.map(([, options]) => options.redirect)).toEqual(["error", "error"]);
});

it("rejects a delayed old-account response before callers can repopulate caches", async () => {
  const { api, account } = client();
  let respond;
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  fetch.mockResponseOnce(identity(account));
  fetch.mockResponseOnce(() => {
    requestStarted();
    return new Promise((resolve) => {
      respond = resolve;
    });
  });
  const cacheWrite = jest.fn();
  const request = api.findAll().then(cacheWrite);
  await started;
  await AccountContext.transition(async () => {});
  respond(JSON.stringify({ body: [{ id: uuid() }] }));
  await expect(request).rejects.toThrow("selected account changed");
  expect(cacheWrite).not.toHaveBeenCalled();
});
