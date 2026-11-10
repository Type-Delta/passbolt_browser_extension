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
 * @since         3.7.0
 */

import GeneratePortIdController from "./generatePortIdController";
import WorkersSessionStorage from "../../service/sessionStorage/workersSessionStorage";
import WorkerEntity from "../../model/entity/worker/workerEntity";
import { v4 as uuidv4 } from "uuid";

jest.spyOn(WorkersSessionStorage, "addWorker");

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

describe("GeneratePortIdController", () => {
  describe("GeneratePortIdController::isAllowedToGeneratePortId", () => {
    it("Should allowed to generate port id", async () => {
      expect.assertions(6);
      // data mocked
      const worker = {
        name: "WebIntegration",
      };
      // process
      const controller = new GeneratePortIdController(worker, "requestId");
      // expectations
      expect(controller.isAllowedToGeneratePortId(worker.name, "Recover")).toBeFalsy();
      expect(controller.isAllowedToGeneratePortId(worker.name, "Setup")).toBeFalsy();
      expect(controller.isAllowedToGeneratePortId(worker.name, "App")).toBeFalsy();
      expect(controller.isAllowedToGeneratePortId(worker.name, "Unknown")).toBeFalsy();
      expect(controller.isAllowedToGeneratePortId(worker.name, "InFormCallToAction")).toBeTruthy();
      expect(controller.isAllowedToGeneratePortId(worker.name, "InFormMenu")).toBeTruthy();
    });

    it("Should not allowed to generate port id for unknown application", async () => {
      expect.assertions(2);
      // data mocked
      const worker = {
        name: "Unknown",
      };
      // process
      const controller = new GeneratePortIdController(worker, "requestId");
      // expectations
      expect(controller.isAllowedToGeneratePortId(worker.name, "Recover")).toBeFalsy();
      expect(controller.isAllowedToGeneratePortId(worker.name, "Unknown")).toBeFalsy();
    });
  });

  describe("GeneratePortIdController::exec", () => {
    it("Should store worker and generate a port id for setup", async () => {
      expect.assertions(2);
      // data mocked
      const worker = {
        tab: {
          id: 1,
        },
        name: "SetupBootstrap",
        port: { _port: { name: uuidv4() } },
      };
      await WorkersSessionStorage.addWorker(
        new WorkerEntity({
          id: worker.port._port.name,
          name: worker.name,
          tabId: worker.tab.id,
          frameId: 0,
          status: WorkerEntity.STATUS_CONNECTED,
          account_id: null,
        }),
      );
      // process
      const controller = new GeneratePortIdController(worker, "requestId");
      const id = await controller.exec("Setup");
      // data expected
      const workerEntity = new WorkerEntity({
        id: id,
        tabId: worker.tab.id,
        name: "Setup",
        frameId: null,
        status: WorkerEntity.STATUS_WAITING_CONNECTION,
        account_id: null,
      });
      // expectations
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(WorkersSessionStorage.addWorker).toHaveBeenCalledWith(workerEntity);
    });

    it.each(["App", "FileIframe"])("Should preserve the parent account binding for %s", async (applicationName) => {
      const accountId = uuidv4();
      const parent = new WorkerEntity({
        id: uuidv4(),
        name: "AppBootstrap",
        tabId: 1,
        frameId: 0,
        status: WorkerEntity.STATUS_CONNECTED,
        account_id: accountId,
      });
      await WorkersSessionStorage.addWorker(parent);
      const controller = new GeneratePortIdController({
        name: parent.name,
        tab: { id: parent.tabId },
        port: { _port: { name: parent.id } },
      });

      const id = await controller.exec(applicationName);

      expect(await WorkersSessionStorage.getWorkerById(id)).toEqual(
        expect.objectContaining({ name: applicationName, account_id: accountId, tabId: parent.tabId }),
      );
    });

    it("Should not generate a child after the originating worker is removed", async () => {
      const controller = new GeneratePortIdController({
        name: "AppBootstrap",
        tab: { id: 1 },
        port: { _port: { name: uuidv4() } },
      });

      await expect(controller.exec("App")).rejects.toThrow("The originating worker is no longer available.");
      expect(WorkersSessionStorage.addWorker).not.toHaveBeenCalled();
    });

    it("Should not store worker and generate a port id for application not allowed", async () => {
      expect.assertions(1);
      // data mocked
      const worker = {
        tab: {
          id: 1,
        },
        name: "AppBootstrap",
      };
      // process
      const controller = new GeneratePortIdController(worker, "requestId");
      try {
        await controller.exec("QuickAccess");
      } catch (error) {
        // expectations
        expect(error.message).toStrictEqual("The application is not allowed to open the application QuickAccess");
      }
    });

    it("Should not allowed to generate port id for an application name that is not a string", async () => {
      expect.assertions(1);
      // data mocked
      const worker = {
        tab: {
          id: 1,
        },
        name: "AppBootstrap",
      };
      // process
      const controller = new GeneratePortIdController(worker, "requestId");
      try {
        await controller.exec({ name: "QuickAccess" });
      } catch (error) {
        // expectations
        expect(error.message).toStrictEqual("The application name should be a string");
      }
    });
  });
});
