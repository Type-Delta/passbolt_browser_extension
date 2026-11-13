import SavedAccountRegistry from "./savedAccountRegistry";
import AccountEntity from "../../model/entity/account/accountEntity";
import { defaultAccountDto } from "../../model/entity/account/accountEntity.test.data";
import MockExtension from "../../../../../test/mocks/mockExtension";

const SsoDataStorage = jest.requireActual("../indexedDB_storage/ssoDataStorage").default;

it("only the migrated original identity can open the legacy SSO database", async () => {
  await MockExtension.withConfiguredAccount();
  const state = await SavedAccountRegistry.read();
  const originalId = state.active_account_id;
  const added = await SavedAccountRegistry.save(
    new AccountEntity(defaultAccountDto({ domain: "https://another.test" })),
  );
  const requests = [];
  let didOpen;
  let opened = new Promise((resolve) => {
    didOpen = resolve;
  });
  const previousIndexedDB = global.indexedDB;
  global.indexedDB = {
    open: jest.fn((name) => {
      const request = { result: { name, close: jest.fn() } };
      requests.push(request);
      didOpen();
      return request;
    }),
  };
  try {
    const original = SsoDataStorage.getDbHandler();
    // Wait for the storage read without completing IndexedDB.open.
    await opened;
    expect(indexedDB.open).toHaveBeenLastCalledWith("sso_kit_db", 1);
    const next = await SavedAccountRegistry.read();
    next.active_account_id = added.id;
    await SavedAccountRegistry.write(next);
    // A pending database open keeps its captured account identity across the asynchronous completion.
    requests[0].onsuccess();
    expect((await original).name).toBe("sso_kit_db");
    opened = new Promise((resolve) => {
      didOpen = resolve;
    });
    const second = SsoDataStorage.getDbHandler();
    await opened;
    expect(indexedDB.open).toHaveBeenLastCalledWith(`sso_kit_db-${added.id}`, 1);
    requests[1].onsuccess();
    expect((await second).name).toBe(`sso_kit_db-${added.id}`);
    expect(added.id).not.toBe(originalId);
  } finally {
    global.indexedDB = previousIndexedDB;
  }
});
