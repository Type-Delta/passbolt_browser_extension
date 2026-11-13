import { OpenpgpAssertion } from "../../utils/openpgp/openpgpAssertions";
import GetGpgKeyInfoService from "./getGpgKeyInfoService";
import i18n from "../../sdk/i18n";

/** Shared import rules for recovery and extension-owned enrollment. */
export default class ValidatePrivateGpgKeyService {
  static async validate(armoredKey) {
    const key = await OpenpgpAssertion.readKeyOrFail(armoredKey);
    OpenpgpAssertion.assertEncryptedPrivateKey(key);
    const keyInfo = await GetGpgKeyInfoService.getKeyInfo(key);
    if (!keyInfo.isValid) {
      console.warn("The private key should be a valid openpgp key.");
    }
    if (keyInfo.revoked) {
      throw new Error(i18n.t("The private key should not be revoked."));
    } else if (keyInfo.isExpired) {
      throw new Error(i18n.t("The private key should not be expired."));
    }
    return keyInfo;
  }
}
