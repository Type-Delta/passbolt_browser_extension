import IsEmailValidator from "passbolt-styleguide/src/shared/lib/Validator/IsEmailValidator";
import GpgKeyError from "../../error/GpgKeyError";
import ValidatePrivateGpgKeyService from "../crypto/validatePrivateGpgKeyService";
import { OpenpgpAssertion } from "../../utils/openpgp/openpgpAssertions";
import DecryptPrivateKeyService from "../crypto/decryptPrivateKeyService";
import SavedServerRegistry from "./savedServerRegistry";
import VerifyAccountServerService from "./verifyAccountServerService";
import SavedAccountRegistry from "./savedAccountRegistry";

/** Enrollment checks never inspect or modify the foreground keyring. */
export default class AccountOnboardingService {
  static async suggestedServer(sourceUrl, assertCurrent = () => {}) {
    if (!sourceUrl) {
      return null;
    }
    try {
      const page = new URL(sourceUrl);
      if (page.protocol !== "https:" || page.username || page.password) {
        return null;
      }
      const known = (await SavedServerRegistry.read(assertCurrent))
        .filter((server) => {
          const base = new URL(server.domain);
          return (
            page.origin === base.origin &&
            (page.pathname === base.pathname || page.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`))
          );
        })
        .sort((a, b) => b.domain.length - a.domain.length)[0];
      const path = page.pathname.replace(/\/(?:app|auth|mfa)(?:\/.*)?$/, "");
      const domain = known?.domain || SavedAccountRegistry.canonicalDomain(`${page.origin}${path}`);
      const server = await this.verifyServer({ domain, remember: false }, assertCurrent);
      assertCurrent();
      return server.domain;
    } catch {
      assertCurrent();
      return null;
    }
  }

  static async verifyServer(input, assertCurrent = () => {}) {
    const server = await VerifyAccountServerService.verify(input.domain);
    assertCurrent();
    const known = (await SavedServerRegistry.read(assertCurrent)).find((item) => item.domain === server.domain);
    if (known && known.server_key_fingerprint !== server.server_key_fingerprint) {
      throw new Error("The saved server key changed. Verify the server before adding another account.");
    }
    if (input.remember === true) {
      await SavedServerRegistry.remember(server, assertCurrent);
    }
    assertCurrent();
    return { ...server, is_known: Boolean(known) };
  }

  static async checkPassphrase(input) {
    let key;
    try {
      key = await OpenpgpAssertion.readKeyOrFail(input?.user_private_armored_key);
      OpenpgpAssertion.assertEncryptedPrivateKey(key);
    } catch (error) {
      throw new GpgKeyError(error.message);
    }
    await DecryptPrivateKeyService.decrypt(key, input.passphrase);
  }

  static async validatePrivateKey(input) {
    const username = input?.username?.trim();
    if (!username || !IsEmailValidator.validate(username)) {
      throw new Error("A valid email is required.");
    }
    try {
      const info = await ValidatePrivateGpgKeyService.validate(input.user_private_armored_key);
      return {
        fingerprint: info.fingerprint,
        expires: info.expires,
        matches_email: info.userIds.some((uid) => uid.email?.trim().toLowerCase() === username.toLowerCase()),
      };
    } catch (error) {
      throw new GpgKeyError(error.message);
    }
  }
}
