/**
 * Passbolt ~ Open source password manager for teams
 * Copyright (c) Passbolt SA (https://www.passbolt.com)
 *
 * Licensed under GNU Affero General Public License version 3 of the or any later version.
 * For full copyright and license information, please see the LICENSE.txt
 * Redistributions of files must retain the above copyright notice.
 *
 * @copyright     Copyright (c) Passbolt SA (https://www.passbolt.com)
 * @license       https://opensource.org/licenses/AGPL-3.0 AGPL License
 * @link          https://www.passbolt.com Passbolt(tm)
 * @since         2.11.0
 */
import NotFoundError from "../error/notFoundError";
import PassboltBadResponseError from "../error/passboltBadResponseError";
import AbstractService from "passbolt-styleguide/src/shared/services/api/abstract/abstractService";

const AUTH_RESOURCE_NAME = "/auth";
export const MFA_VERIFY_ERROR_REGEXP = /mfa\/verify\/error\.json$/;

import { assertAuthenticatedAccount, assertMfaReadiness } from "./account/accountApiGuard";

class AuthenticationStatusService extends AbstractService {
  /**
   * @constructor
   * @param {ApiClientOptions} apiClientOptions
   * @public
   */
  constructor(apiClientOptions) {
    super(apiClientOptions, AUTH_RESOURCE_NAME);
  }
  /**
   * Check if the current user is authenticated.
   * @returns {Promise<boolean>}
   * @throws {PassboltBadResponseError} If the response can't be parsed
   * @throws {MfaAuthenticationRequiredError} If there was an error during the MFA
   * @throws {NotFoundError} If the server answered with 404
   */
  async isAuthenticated() {
    const url = this.apiClient.buildUrl(`${this.apiClient.baseUrl.toString()}/is-authenticated`, null);

    const fetchOptions = {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "content-type": "application/json",
      },
    };
    let response;
    try {
      response = await this.apiClient.sendRequest("GET", url, null, fetchOptions);
    } catch (error) {
      // Fetch hides the stock 302 with redirect:error. Only verified readiness can establish MFA.
      await assertMfaReadiness(this.apiClient.options);
      throw error;
    }

    let responseJson;
    try {
      //Get response on json format
      responseJson = await response.json();
    } catch (error) {
      console.error(error);
      // If the response cannot be parsed, it's not a Passbolt API response. It can be a nginx error (504).
      throw new PassboltBadResponseError();
    }

    if (response.ok) {
      if (this.apiClient.options.accountContext?.requireIdentity) {
        await assertAuthenticatedAccount(this.apiClient.options, this.apiClient.options.accountContext.account);
      }
      return true;
    }

    // MFA required. @note: on safari response.url is an empty string in that case
    if (MFA_VERIFY_ERROR_REGEXP.test(responseJson.header?.url) || MFA_VERIFY_ERROR_REGEXP.test(response.url)) {
      await assertMfaReadiness(this.apiClient.options);
      throw new PassboltBadResponseError();
    } else if (response.status === 404) {
      // Entry point not found.
      throw new NotFoundError();
    }

    return false;
  }
}

export default AuthenticationStatusService;
