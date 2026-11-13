/**
 * Passbolt ~ Open source password manager for teams
 * Copyright (c) 2022 Passbolt SA (https://www.passbolt.com)
 *
 * Licensed under GNU Affero General Public License version 3 of the or any later version.
 * For full copyright and license information, please see the LICENSE.txt
 * Redistributions of files must retain the above copyright notice.
 *
 * @copyright     Copyright (c) 2022 Passbolt SA (https://www.passbolt.com)
 * @license       https://opensource.org/licenses/AGPL-3.0 AGPL License
 * @link          https://www.passbolt.com Passbolt(tm)
 * @since         3.6.0
 */

/**
 * Mock an API response
 * @param {Object} body The response body
 * @returns {Promise<string>} The response serialized in JSON.
 */
exports.mockApiResponse = (body = {}, header = {}) => Promise.resolve(JSON.stringify({header: header, body: body}));

/**
 * Mock an API response that contains pagination information.
 * @param {Array<*>} body a single page of data to be returned by the API
 * @param {*} header the header part of the response, the pagination is computed based on the number of element in the body and the pageCount
 * @param {*} pageCount the number of page the header should indicate.
 * @returns {Promise<object>}
 */
exports.mockApiResponseWithPagination = (body = [], header = {}, pageCount = 1) => Promise.resolve(JSON.stringify({
  header: {
    pagination: {
      count: body.length,
      limit: pageCount * body.length,
      page: 1,
    },
    ...header
  },
  body: body
}));

exports.mockApiRedirectResponse = (redirectTo, status = 302) => Promise.resolve({
  status: status,
  url: redirectTo,
  body: JSON.stringify({
    header: {
      status: status
    },
    body: {}
  })
});

exports.mockApiResponseError = (status, errorMessage, body = {}) => Promise.resolve({
  status: status,
  body: JSON.stringify({
    header: {
      message: errorMessage,
      status: status
    },
    body: body
  })
});

/**
 * Queue the account identity check and its protected API request.
 * @param {Object} apiClientOptions The options bound to the authenticated account.
 * @param {string|RegExp|Function} urlOrPredicate The protected endpoint matcher.
 * @param {string|Function} bodyOrFunction The endpoint response or callback.
 * @param {Object} init The endpoint response options.
 * @returns {*} The queued fetch mock.
 */
exports.mockAuthenticatedApiRequest = (apiClientOptions, urlOrPredicate, bodyOrFunction, init) => {
  const account = apiClientOptions.accountContext.account;
  fetch.doMockOnceIf(/\/users\/me\.json(?:\?|$)/, () =>
    exports.mockApiResponse({
      id: account.userId,
      username: account.username,
      gpgkey: { fingerprint: account.userKeyFingerprint },
    }),
  );
  return fetch.doMockOnceIf(urlOrPredicate, bodyOrFunction, init);
};
