import { beforeEach, describe, expect, it, vi } from "vitest";

const msal = {
  initialize: vi.fn(async () => {}),
  handleRedirectPromise: vi.fn(async () => null),
  getAllAccounts: vi.fn(() => [{ username: "me" }]),
  setActiveAccount: vi.fn(),
  getActiveAccount: vi.fn(() => ({ username: "me" })),
  acquireTokenSilent: vi.fn(),
  acquireTokenRedirect: vi.fn(async () => {}),
  loginRedirect: vi.fn(async () => {}),
  logoutRedirect: vi.fn(async () => {}),
};
const broadcast = vi.fn(async () => {});

vi.mock("@azure/msal-browser", () => {
  class AuthError extends Error {
    constructor(public errorCode: string) {
      super(errorCode);
    }
  }
  return {
    PublicClientApplication: vi.fn(function () {
      return msal;
    }),
    AuthError,
    BrowserAuthError: class extends AuthError {},
    InteractionRequiredAuthError: class extends AuthError {},
  };
});
vi.mock("@azure/msal-browser/redirect-bridge", () => ({ broadcastResponseToMainFrame: broadcast }));

async function load(inIframe = false) {
  vi.resetModules();
  const win: Record<string, unknown> = {};
  win.parent = inIframe ? {} : win;
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", { origin: "https://x.test" });
  return { auth: await import("./auth"), lib: await import("@azure/msal-browser") };
}

beforeEach(() => vi.clearAllMocks());

describe("initAuth", () => {
  it("signs in with the cached account", async () => {
    const { auth } = await load();
    expect(await auth.initAuth("cid")).toBe(true);
    expect(msal.setActiveAccount).toHaveBeenCalledWith({ username: "me" });
  });
  it("acts as the redirect bridge inside MSAL's silent-renewal iframe", async () => {
    const { auth } = await load(true);
    expect(await auth.initAuth("cid")).toBe(false);
    expect(broadcast).toHaveBeenCalled();
    expect(msal.handleRedirectPromise).not.toHaveBeenCalled();
  });
});

describe("getToken", () => {
  it("returns the silently acquired token", async () => {
    const { auth } = await load();
    await auth.initAuth("cid");
    msal.acquireTokenSilent.mockResolvedValueOnce({ accessToken: "tok" });
    expect(await auth.getToken(true)).toBe("tok");
    expect(msal.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
  });
  it.each(["InteractionRequiredAuthError", "BrowserAuthError"] as const)("redirects to sign in on %s", async (cls) => {
    const { auth, lib } = await load();
    await auth.initAuth("cid");
    msal.acquireTokenSilent.mockRejectedValueOnce(new (lib[cls] as unknown as new (code: string) => Error)("timed_out"));
    await expect(auth.getToken()).rejects.toThrow("Redirecting to sign-in");
    expect(msal.acquireTokenRedirect).toHaveBeenCalled();
  });
  it("does not redirect when offline", async () => {
    const { auth, lib } = await load();
    await auth.initAuth("cid");
    msal.acquireTokenSilent.mockRejectedValueOnce(new (lib.BrowserAuthError as unknown as new (code: string) => Error)("no_network_connectivity"));
    await expect(auth.getToken()).rejects.toThrow("no_network_connectivity");
    expect(msal.acquireTokenRedirect).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  it("logs out through Microsoft", async () => {
    const { auth } = await load();
    await auth.initAuth("cid");
    await auth.signOut();
    expect(msal.logoutRedirect).toHaveBeenCalled();
  });
});
