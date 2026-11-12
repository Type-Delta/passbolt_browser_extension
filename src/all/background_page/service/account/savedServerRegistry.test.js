import { pgpKeys } from "passbolt-styleguide/test/fixture/pgpKeys/keys";
import SavedServerRegistry from "./savedServerRegistry";
import SavedAccountRegistry from "./savedAccountRegistry";
import AccountEntity from "../../model/entity/account/accountEntity";
import { defaultAccountDto } from "../../model/entity/account/accountEntity.test.data";

it("keeps public servers independently without changing the saved-account schema or persisting supplied secrets", async () => {
  const accounts = await SavedAccountRegistry.read();
  await SavedServerRegistry.remember({
    domain: "https://VAULT.example:443/team/",
    server_key_fingerprint: pgpKeys.server.fingerprint,
    checked_at: 123,
    passphrase: "must not persist",
    user_private_armored_key: pgpKeys.ada.private,
  });
  expect(await SavedServerRegistry.read()).toEqual([
    {
      domain: "https://vault.example/team",
      server_key_fingerprint: pgpKeys.server.fingerprint.toUpperCase(),
      checked_at: 123,
    },
  ]);
  expect(await SavedAccountRegistry.read()).toEqual(accounts);
  const stored = (await browser.storage.local.get("saved-servers-v1"))["saved-servers-v1"];
  expect(stored).toEqual({ version: 1, servers: await SavedServerRegistry.read() });
});

it("migrates account pins locally, retains their server after account removal, and rejects an unconfirmed replacement", async () => {
  const account = await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  const fetch = jest.spyOn(global, "fetch");
  const [server] = await SavedServerRegistry.read();
  expect(server.domain).toBe(account.domain);
  expect(server.server_key_fingerprint).toBe(pgpKeys.server.fingerprint.toUpperCase());
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
  await SavedAccountRegistry.write({ version: 1, accounts: [], active_account_id: null });
  expect(await SavedServerRegistry.read()).toEqual([server]);
  await expect(
    SavedServerRegistry.remember({ ...server, server_key_fingerprint: pgpKeys.ada.fingerprint }),
  ).rejects.toThrow("server key changed");
  expect(await SavedServerRegistry.read()).toEqual([server]);
});

it("uses an account's explicitly replaced pin instead of the older discovered key", async () => {
  await SavedAccountRegistry.save(new AccountEntity(defaultAccountDto()), true);
  await SavedServerRegistry.read();
  await SavedAccountRegistry.replaceServerKey("https://passbolt.local", pgpKeys.ada.public);
  expect((await SavedServerRegistry.read())[0].server_key_fingerprint).toBe(pgpKeys.ada.fingerprint.toUpperCase());
});
