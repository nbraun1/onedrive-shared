// App lock: the device's own Face ID / fingerprint / passcode via a platform passkey.
// shortcut: no server verifies the assertion; a client-side gate only, upgrade needs a backend.

export type LockSettings = { id: string; delay: number };

export function loadLock(st: Storage = localStorage): LockSettings | null {
  try {
    const v = JSON.parse(st.getItem("appLock") ?? "null");
    return typeof v?.id === "string" && v.id && typeof v.delay === "number" ? { id: v.id, delay: v.delay } : null;
  } catch {
    return null;
  }
}

export function saveLock(s: LockSettings | null, st: Storage = localStorage) {
  if (s) st.setItem("appLock", JSON.stringify(s));
  else st.removeItem("appLock");
}

/** Lock when never hidden (cold start), the clock went backwards, or the delay has passed. */
export const isDue = (hiddenAt: number | null, now: number, delay: number) =>
  hiddenAt === null || now < hiddenAt || now - hiddenAt >= delay;

export async function lockAvailable(): Promise<boolean> {
  try {
    return (await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable()) ?? false;
  } catch {
    return false;
  }
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const toB64url = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Creates the passkey (asks for Face ID); returns its id. Throws when cancelled or refused. */
export async function createPasskey(): Promise<string> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Shared Drive" },
      user: { id: random(16), name: "Shared Drive", displayName: "Shared Drive" },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey created");
  return toB64url(cred.rawId);
}

/** True once the device verified the user for this passkey; any failure or cancel is false. */
export async function verifyPasskey(id: string): Promise<boolean> {
  try {
    return !!(await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        allowCredentials: [{ type: "public-key", id: fromB64url(id) }],
        userVerification: "required",
      },
    }));
  } catch {
    return false;
  }
}
