/**
 * Passbolt ~ Open source password manager for teams
 * Copyright (c) Passbolt SARL (https://www.passbolt.com)
 *
 * Licensed under GNU Affero General Public License version 3 of the or any later version.
 * For full copyright and license information, please see the LICENSE.txt
 * Redistributions of files must retain the above copyright notice.
 *
 * @copyright     Copyright (c) Passbolt SA (https://www.passbolt.com)
 * @license       https://opensource.org/licenses/AGPL-3.0 AGPL License
 * @link          https://www.passbolt.com Passbolt(tm)
 * @since         2.0.0
 */
import DeleteGroupController from "../controller/group/deleteGroupController";
import DeleteDryRunGroupController from "../controller/group/deleteDryRunGroupController";
import GroupsUpdateController from "../controller/group/groupUpdateController";
import GroupCreateController from "../controller/group/groupCreateController";
import FindMyGroupsController from "../controller/group/findMyGroupsController";
import UpdateAllGroupsLocalStorageController from "../controller/group/updateAllGroupsLocalStorageController";
import FindGroupsByIdsForShareController from "../controller/group/findGroupsByIdsForShareController";

/**
 * Listens to the groups events
 * @param {Worker} worker The worker
 * @param {ApiClientOptions} apiClientOptions The api client options
 * @param {AccountEntity} account The account
 */
const listen = function (worker, apiClientOptions, account) {
  /*
   * Pull the groups from the API and update the local storage.
   *
   * @listens passbolt.groups.update-local-storage
   * @param {uuid} requestId The request identifier
   */
  worker.port.on("passbolt.groups.update-local-storage", async (requestId) => {
    const controller = new UpdateAllGroupsLocalStorageController(worker, requestId, apiClientOptions, account);
    await controller._exec();
  });

  /*
   * Find all the groups
   *
   * @listens passbolt.groups.find-my-groups
   * @param requestId {uuid} The request identifier
   * @param options {object} The options to apply to the find
   */
  worker.port.on("passbolt.groups.find-my-groups", async (requestId) => {
    const controller = new FindMyGroupsController(worker, requestId, apiClientOptions);
    await controller._exec();
  });

  /*
   * Find groups by their ids.
   *
   * @listens passbolt.groups.find-by-ids-for-share
   * @param {uuid} requestId The request identifier
   * @param {Array<uuid>} groupIds The ids of the groups to retrieve
   */
  worker.port.on("passbolt.groups.find-by-ids-for-share", async (requestId, groupIds) => {
    const controller = new FindGroupsByIdsForShareController(worker, requestId, apiClientOptions);
    await controller._exec(groupIds);
  });

  /*
   * ==================================================================================
   *  CRUD
   * ==================================================================================
   */
  /*
   * Create a groups
   *
   * @listens passbolt.groups.create
   * @param requestId {uuid} The request identifier
   * @param groupDto {Object} The group object, example:
   *  {name: 'group name', groups_users: [{user_id: <UUID>, is_admin: <boolean>}]}
   */
  worker.port.on("passbolt.groups.create", async (requestId, groupDto) => {
    const controller = new GroupCreateController(worker, requestId, apiClientOptions, account);
    await controller._exec(groupDto);
  });

  /*
   * Edit a groups
   *
   * @listens passbolt.groups.update
   * @param requestId {uuid} The request identifier
   * @param groupDto {Object} The group object, example:
   *  {name: 'group name', groups_users: [{user_id: <UUID>, is_admin: <boolean>, deleted: <boolean>}]}
   */
  worker.port.on("passbolt.groups.update", async (requestId, groupDto) => {
    const controller = new GroupsUpdateController(worker, requestId, apiClientOptions, account);
    await controller._exec(groupDto);
  });

  /*
   * Delete a Group - dry run
   *
   * @param {string} requestId The request identifier uuid
   * @param {string} groupId The group uuid
   */
  worker.port.on("passbolt.groups.delete-dry-run", async (requestId, groupId) => {
    const controller = new DeleteDryRunGroupController(worker, requestId, apiClientOptions, account);
    await controller._exec(groupId);
  });

  /*
   * Delete a Group
   *
   * @param {string} requestId The request identifier uuid
   * @param {string} groupId The group uuid
   * @param {object} [transferDto] optional data ownership transfer
   * example: {owners: [{aco_foreign_key: <UUID>, id: <UUID>}]}
   */
  worker.port.on("passbolt.groups.delete", async (requestId, groupId, transferDto) => {
    const controller = new DeleteGroupController(worker, requestId, apiClientOptions, account);
    await controller._exec(groupId, transferDto);
  });
};
export const GroupEvents = { listen };
