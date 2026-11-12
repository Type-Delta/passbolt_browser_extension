import { OpenpgpAssertion } from "../../utils/openpgp/openpgpAssertions";
import SavedAccountRegistry from "./savedAccountRegistry";
import PassboltServiceUnavailableError from "passbolt-styleguide/src/shared/lib/Error/PassboltServiceUnavailableError";

/** Anonymous discovery. Authentication and CSRF initialization remain owned by final enrollment. */
export default class VerifyAccountServerService {
  static async verify(domain) {
    const canonical = SavedAccountRegistry.canonicalDomain(domain);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${canonical}/auth/verify.json?api-version=v2`, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      let json;
      try {
        json = await response.json();
      } catch {
        throw new Error("This URL did not return a valid Passbolt server response.");
      }
      if (!response.ok || json.header?.status !== "success" || json.header?.code !== 200) {
        throw new Error("This URL did not return a valid Passbolt server response.");
      }
      const key = await OpenpgpAssertion.readKeyOrFail(json.body?.keydata);
      OpenpgpAssertion.assertPublicKey(key);
      const fingerprint = key.getFingerprint().toUpperCase();
      if (json.body?.fingerprint?.toUpperCase() !== fingerprint) {
        throw new Error("The Passbolt server key fingerprint does not match its public key.");
      }
      return { domain: canonical, server_key_fingerprint: fingerprint, checked_at: Date.now() };
    } catch (error) {
      if (controller.signal.aborted || error instanceof TypeError) {
        throw new PassboltServiceUnavailableError(
          controller.signal.aborted
            ? "The server did not respond within ten seconds."
            : "The server could not be reached.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
