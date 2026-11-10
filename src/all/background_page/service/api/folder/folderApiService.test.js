import { enableFetchMocks } from "jest-fetch-mock";
import {
  mockAuthenticatedApiRequest,
  mockApiResponse,
  mockApiResponseError,
} from "../../../../../../test/mocks/mockApiResponse";
import AccountEntity from "../../../model/entity/account/accountEntity";
import { defaultAccountDto } from "../../../model/entity/account/accountEntity.test.data";
import BuildApiClientOptionsService from "../../account/buildApiClientOptionsService";
import PassboltApiFetchError from "passbolt-styleguide/src/shared/lib/Error/PassboltApiFetchError";
import PassboltServiceUnavailableError from "passbolt-styleguide/src/shared/lib/Error/PassboltServiceUnavailableError";
import FolderApiService from "./folderApiService";
import { v4 as uuidv4 } from "uuid";

describe("FolderApiService", () => {
  let apiClientOptions;
  beforeEach(async () => {
    enableFetchMocks();
    fetch.resetMocks();
    const account = new AccountEntity(defaultAccountDto());
    apiClientOptions = BuildApiClientOptionsService.buildFromAccount(account);
  });

  describe("::update", () => {
    it("should update the folder with the given id on the API", async () => {
      expect.assertions(2);
      const folderId = uuidv4();
      const folderData = { name: "Renamed folder" };
      let reqPayload;
      mockAuthenticatedApiRequest(apiClientOptions, new RegExp(`/folders/${folderId}\\.json`), async (req) => {
        expect(req.method).toEqual("PUT");
        reqPayload = await req.json();
        return mockApiResponse({ id: folderId, ...folderData });
      });

      const service = new FolderApiService(apiClientOptions);
      await service.update(folderId, folderData);

      expect(reqPayload).toEqual(expect.objectContaining(folderData));
    });

    it("should throw an error if the folder id is not a valid uuid", async () => {
      expect.assertions(1);
      const service = new FolderApiService(apiClientOptions);
      const promise = service.update("not a uuid", { name: "test" });
      await expect(promise).rejects.toThrow(TypeError);
    });

    it("should throw an error if the folder data is empty", async () => {
      expect.assertions(1);
      const service = new FolderApiService(apiClientOptions);
      const promise = service.update(uuidv4(), null);
      await expect(promise).rejects.toThrow(TypeError);
    });

    it("should throw an error if the API returns an error response", async () => {
      expect.assertions(2);
      const folderId = uuidv4();
      mockAuthenticatedApiRequest(apiClientOptions, /folders/, () =>
        mockApiResponseError(500, "Something went wrong!"),
      );

      const service = new FolderApiService(apiClientOptions);
      const promise = service.update(folderId, { name: "test" });
      await expect(promise).rejects.toThrow(PassboltApiFetchError);
      await expect(promise).rejects.toThrow("Something went wrong!");
    });

    it("should throw a service unavailable error if the API is unreachable", async () => {
      expect.assertions(1);
      const folderId = uuidv4();
      mockAuthenticatedApiRequest(apiClientOptions, /folders/, () => {
        throw new Error("Service unavailable");
      });

      const service = new FolderApiService(apiClientOptions);
      const promise = service.update(folderId, { name: "test" });
      await expect(promise).rejects.toThrow(PassboltServiceUnavailableError);
    });
  });
  describe("::delete", () => {
    it("deletes the folder with the given id from the API, without a cascade query parameter by default.", async () => {
      expect.assertions(3);
      const folderId = uuidv4();
      let request;
      mockAuthenticatedApiRequest(apiClientOptions, new RegExp(`/folders/${folderId}\\.json`), async (req) => {
        request = req;
        return mockApiResponse(null);
      });

      const service = new FolderApiService(apiClientOptions);
      await expect(service.delete(folderId, false)).resolves.not.toThrow();

      expect(request.method).toEqual("DELETE");
      expect(new URL(request.url).searchParams.has("cascade")).toStrictEqual(false);
    });

    it("adds the cascade=1 query parameter when cascade is true.", async () => {
      expect.assertions(2);
      const folderId = uuidv4();
      let request;
      mockAuthenticatedApiRequest(apiClientOptions, new RegExp(`/folders/${folderId}\\.json`), async (req) => {
        request = req;
        return mockApiResponse(null);
      });

      const service = new FolderApiService(apiClientOptions);
      await service.delete(folderId, true);

      expect(request.method).toEqual("DELETE");
      expect(new URL(request.url).searchParams.get("cascade")).toStrictEqual("1");
    });

    it("throws an error if the folder id is not a valid uuid, before any request.", async () => {
      expect.assertions(2);

      const service = new FolderApiService(apiClientOptions);
      const promise = service.delete("not-a-uuid");

      await expect(promise).rejects.toThrow(TypeError);
      expect(fetch.mock.calls.length).toStrictEqual(0);
    });

    it("throws an error if the API returns an error response.", async () => {
      expect.assertions(2);
      const folderId = uuidv4();
      mockAuthenticatedApiRequest(apiClientOptions, /folders/, () =>
        mockApiResponseError(500, "Something went wrong!"),
      );

      const service = new FolderApiService(apiClientOptions);
      const promise = service.delete(folderId);

      await expect(promise).rejects.toThrow(PassboltApiFetchError);
      await expect(promise).rejects.toThrow("Something went wrong!");
    });

    it("throws a service unavailable error if the request fails outside of the API.", async () => {
      expect.assertions(2);
      const folderId = uuidv4();
      mockAuthenticatedApiRequest(apiClientOptions, /folders/, () => {
        throw new Error("Service unavailable");
      });

      const service = new FolderApiService(apiClientOptions);
      const promise = service.delete(folderId);

      await expect(promise).rejects.toThrow(PassboltServiceUnavailableError);
      await expect(promise).rejects.toThrow("Unable to reach the server, an unexpected error occurred");
    });
  });
});
