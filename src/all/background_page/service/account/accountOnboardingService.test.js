import { pgpKeys } from "passbolt-styleguide/test/fixture/pgpKeys/keys";
import AccountOnboardingService from "./accountOnboardingService";
import Keyring from "../../model/keyring";

afterEach(() => jest.restoreAllMocks());

it("validates the supplied encrypted key locally and exposes only provisional metadata", async () => {
  const request = jest.spyOn(global, "fetch");
  const before = await browser.storage.session.get(null);
  const result = await AccountOnboardingService.validatePrivateKey({
    username: " ADA@passbolt.com ",
    user_private_armored_key: pgpKeys.ada.private,
  });
  expect(result).toEqual({
    fingerprint: pgpKeys.ada.fingerprint.toUpperCase(),
    expires: "Infinity",
    matches_email: true,
  });
  expect(
    await AccountOnboardingService.validatePrivateKey({
      username: "changed@example.test",
      user_private_armored_key: pgpKeys.ada.private,
    }),
  ).toMatchObject({ matches_email: false });
  expect(request).not.toHaveBeenCalled();
  expect(await browser.storage.session.get(null)).toEqual(before);
  request.mockRestore();
});

it("checks the supplied private key with no foreground keyring and never retains the passphrase", async () => {
  const request = jest.spyOn(global, "fetch");
  expect(new Keyring().findPrivate()).toBeUndefined();
  await expect(
    AccountOnboardingService.checkPassphrase({
      user_private_armored_key: pgpKeys.ada.private,
      passphrase: "ada@passbolt.com",
    }),
  ).resolves.toBeUndefined();
  await expect(
    AccountOnboardingService.checkPassphrase({
      user_private_armored_key: pgpKeys.ada.private,
      passphrase: "wrong",
    }),
  ).rejects.toMatchObject({ name: "InvalidMasterPasswordError" });
  expect(new Keyring().findPrivate()).toBeUndefined();
  expect(await browser.storage.session.get(null)).toEqual({});
  expect(request).not.toHaveBeenCalled();
});

it.each([pgpKeys.ada.public, pgpKeys.ada.private_decrypted, pgpKeys.revokedKey.private, pgpKeys.expired.private])(
  "rejects an ineligible import through the recovery rules",
  async (armored) => {
    await expect(
      AccountOnboardingService.validatePrivateKey({
        username: "ada@passbolt.com",
        user_private_armored_key: armored,
      }),
    ).rejects.toMatchObject({ name: "GpgKeyError" });
  },
);
