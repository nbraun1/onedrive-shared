import { InteractionRequiredAuthError, PublicClientApplication } from "@azure/msal-browser";

const SCOPES = ["Files.ReadWrite.All"];
let msal: PublicClientApplication | undefined;

declare global {
  interface Window {
    __TEST_TOKEN__?: string;
  }
}
// Playwright injects a token; import.meta.env.DEV is false in production builds, so this is dropped there.
const testToken = () => (import.meta.env.DEV ? window.__TEST_TOKEN__ : undefined);

/** Finishes a pending sign-in redirect. Returns true when the user is signed in. */
export async function initAuth(clientId: string): Promise<boolean> {
  if (testToken()) return true;
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
    if (e instanceof InteractionRequiredAuthError) {
      await msal!.acquireTokenRedirect({ scopes: SCOPES, account });
      throw new Error("Redirecting to sign-in");
    }
    throw e;
  }
}
