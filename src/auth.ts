import { BrowserAuthError, InteractionRequiredAuthError, PublicClientApplication } from "@azure/msal-browser";
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

const SCOPES = ["Files.ReadWrite.All"];
let msal: PublicClientApplication | undefined;

declare global {
  interface Window {
    __TEST_TOKEN__?: string;
  }
}
// Playwright injects a token; import.meta.env.DEV is false in production builds, so this is dropped there.
const testToken = () => (import.meta.env.DEV ? window.__TEST_TOKEN__ : undefined);
export const hasTestToken = () => !!testToken();

/** Finishes a pending sign-in redirect. Returns true when the user is signed in. */
export async function initAuth(clientId: string): Promise<boolean> {
  if (testToken()) return true;
  // MSAL v5 renews tokens in a hidden iframe pointed at this page; it waits for the page to hand back the response.
  if (window.parent !== window) {
    await broadcastResponseToMainFrame();
    return false;
  }
  msal = new PublicClientApplication({
    auth: {
      clientId,
      authority: "https://login.microsoftonline.com/consumers",
      redirectUri: location.origin + import.meta.env.BASE_URL,
    },
    cache: { cacheLocation: "localStorage" },
  });
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  const account = result?.account ?? msal.getAllAccounts()[0];
  if (account) msal.setActiveAccount(account);
  return !!account;
}

export const signIn = () => msal!.loginRedirect({ scopes: SCOPES });

export async function signOut() {
  if (!testToken()) await msal!.logoutRedirect();
}

export async function getToken(forceRefresh = false): Promise<string> {
  const t = testToken();
  if (t) return t;
  const account = msal!.getActiveAccount();
  if (!account) {
    await signIn();
    throw new Error("Redirecting to sign-in");
  }
  try {
    return (await msal!.acquireTokenSilent({ scopes: SCOPES, account, forceRefresh })).accessToken;
  } catch (e) {
    // A failed iframe renewal (e.g. timed_out when Safari blocks it) also needs a real sign-in; being offline does not.
    if (e instanceof InteractionRequiredAuthError || (e instanceof BrowserAuthError && e.errorCode !== "no_network_connectivity")) {
      await msal!.acquireTokenRedirect({ scopes: SCOPES, account });
      throw new Error("Redirecting to sign-in");
    }
    throw e;
  }
}
