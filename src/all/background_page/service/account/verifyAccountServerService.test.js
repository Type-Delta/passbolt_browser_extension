import { pgpKeys } from "passbolt-styleguide/test/fixture/pgpKeys/keys";
import VerifyAccountServerService from "./verifyAccountServerService";

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it("discovers a canonical deployment anonymously without following redirects or writing session state", async () => {
  const session = await browser.storage.session.get(null);
  const request = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      header: { status: "success", code: 200 },
      body: { keydata: pgpKeys.server.public, fingerprint: pgpKeys.server.fingerprint },
    }),
  });

  const server = await VerifyAccountServerService.verify("https://VAULT.example:443/passbolt/");

  expect(server).toEqual({
    domain: "https://vault.example/passbolt",
    server_key_fingerprint: pgpKeys.server.fingerprint.toUpperCase(),
    checked_at: expect.any(Number),
  });
  expect(request).toHaveBeenCalledWith("https://vault.example/passbolt/auth/verify.json?api-version=v2", {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
    signal: expect.any(AbortSignal),
  });
  expect(await browser.storage.session.get(null)).toEqual(session);
});

it("aborts the transport at ten seconds and returns a controlled reachability error", async () => {
  jest.useFakeTimers();
  let signal;
  jest.spyOn(global, "fetch").mockImplementation((url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  const result = expect(VerifyAccountServerService.verify("https://vault.example")).rejects.toMatchObject({
    name: "PassboltServiceUnavailableError",
  });
  await jest.advanceTimersByTimeAsync(10000);
  await result;
  expect(signal.aborted).toBe(true);
});

it.each(["http://vault.example", "https://user:secret@vault.example", "https://vault.example/?query=1"])(
  "rejects unsafe base URL %s before sending a request",
  async (url) => {
    const request = jest.spyOn(global, "fetch");
    await expect(VerifyAccountServerService.verify(url)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  },
);

it.each([
  { header: { status: "success", code: 200 }, body: { keydata: pgpKeys.server.public, fingerprint: "WRONG" } },
  {
    header: { status: "success", code: 200 },
    body: { keydata: pgpKeys.ada.private, fingerprint: pgpKeys.ada.fingerprint },
  },
  { body: { keydata: pgpKeys.server.public, fingerprint: pgpKeys.server.fingerprint } },
])("rejects a non-Passbolt or mismatched public-key response", async (json) => {
  jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => json });
  await expect(VerifyAccountServerService.verify("https://vault.example")).rejects.toThrow();
});

it("explains an HTML response as an invalid Passbolt server instead of a JSON parser error", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => {
      throw new SyntaxError("Unexpected token '<'");
    },
  });
  await expect(VerifyAccountServerService.verify("https://ordinary.example")).rejects.toThrow(
    "This URL did not return a valid Passbolt server response.",
  );
});
