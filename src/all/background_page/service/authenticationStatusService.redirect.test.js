import { createServer } from "node:http";
import nodeFetch from "node-fetch";
import AuthenticationStatusService from "./authenticationStatusService";
import { ApiClientOptions } from "passbolt-styleguide/src/shared/lib/apiClient/apiClientOptions";
import AccountContext from "./account/accountContext";
import MfaAuthenticationRequiredError from "../error/mfaAuthenticationRequiredError";

let server, options, requests, fetchBefore, readinessStatus, redirectReadiness, signedOut;
beforeEach(async () => {
  requests = [];
  readinessStatus = 200;
  redirectReadiness = false;
  signedOut = false;
  AccountContext.generation = 0;
  AccountContext.transitioning = false;
  server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/team/auth/is-authenticated")) {
      if (signedOut) {
        res.writeHead(403);
        res.end(JSON.stringify({ header: { url: "/team/auth/is-authenticated.json" }, body: null }));
      } else {
        res.writeHead(302, { Location: "/team/mfa/verify/error.json" });
        res.end();
      }
    } else if (redirectReadiness) {
      res.writeHead(302, { Location: "/team-evil/mfa/verify/totp.json" });
      res.end();
    } else {
      res.writeHead(readinessStatus);
      res.end(
        JSON.stringify({
          header: { status: readinessStatus === 200 ? "success" : "error", code: readinessStatus, url: req.url },
          body: null,
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const domain = `http://127.0.0.1:${server.address().port}/team`;
  options = new ApiClientOptions().setBaseUrl(domain);
  options.accountContext = { generation: 0, account: { domain }, requireIdentity: true };
  fetchBefore = global.fetch;
  // This is real node-fetch over a real socket, not jest-fetch-mock's redirect simulation.
  global.fetch = jest.fn(nodeFetch);
});
afterEach(async () => {
  global.fetch = fetchBefore;
  await new Promise((resolve) => server.close(resolve));
});
it("classifies exact TOTP readiness after a real 302 without requesting the destructive redirect target", async () => {
  await expect(new AuthenticationStatusService(options).isAuthenticated()).rejects.toBeInstanceOf(
    MfaAuthenticationRequiredError,
  );
  expect(requests).toEqual([
    "/team/auth/is-authenticated.json?api-version=v2",
    "/team/mfa/verify/totp.json?api-version=v2",
  ]);
  expect(global.fetch.mock.calls.every(([, opts]) => opts.redirect === "error" && opts.credentials === "include")).toBe(
    true,
  );
});
it("does not infer an unsupported provider from a 302 plus TOTP 400", async () => {
  readinessStatus = 400;
  await expect(new AuthenticationStatusService(options).isAuthenticated()).rejects.not.toBeInstanceOf(
    MfaAuthenticationRequiredError,
  );
  expect(requests).toHaveLength(2);
});
it("never follows a readiness redirect to a sibling deployment", async () => {
  redirectReadiness = true;
  await expect(new AuthenticationStatusService(options).isAuthenticated()).rejects.not.toBeInstanceOf(
    MfaAuthenticationRequiredError,
  );
  expect(requests).toHaveLength(2);
  expect(requests.every((url) => url.startsWith("/team/"))).toBe(true);
});
it("returns signed-out status without probing readiness after logout", async () => {
  signedOut = true;
  await expect(new AuthenticationStatusService(options).isAuthenticated()).resolves.toBe(false);
  expect(requests).toHaveLength(1);
});
