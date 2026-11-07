import { expect, test, type Page } from "@playwright/test";
import { EDIT_LINK, fakeOneDrive } from "./fakeOneDrive";

// A Face ID stand-in: Chromium's virtual platform authenticator.
async function authenticator(page: Page, verified = true) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: verified,
      automaticPresenceSimulation: true,
    },
  });
  return (isUserVerified: boolean) => cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified });
}

async function start(page: Page) {
  await page.addInitScript(() => (window.__TEST_TOKEN__ = "test-token"));
  await fakeOneDrive(page);
  await page.goto("./");
  await page.getByLabel("Share link").fill(EDIT_LINK);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("navigation", { name: "Path" })).toContainText("Friend's folder");
}

const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { value: s, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
const leaveAndReturn = async (page: Page) => (await setVisibility(page, "hidden"), await setVisibility(page, "visible"));

const locked = (page: Page) => page.getByRole("heading", { name: "Locked" });
const openSettings = async (page: Page) => {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "App lock" }).click();
};
async function turnOn(page: Page, choice: string) {
  await openSettings(page);
  await page.getByRole("radio", { name: choice }).click();
  await expect(page.getByRole("status")).toHaveText("App lock on");
}

test("is off by default", async ({ page }) => {
  await authenticator(page);
  await start(page);
  await leaveAndReturn(page);
  await expect(locked(page)).toBeHidden();
  await openSettings(page);
  await expect(page.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
});

test("immediately: locks on leaving, Unlock opens it again, one lock screen only", async ({ page }) => {
  await authenticator(page);
  await start(page);
  await turnOn(page, "Immediately");
  await setVisibility(page, "hidden");
  await setVisibility(page, "hidden");
  await expect(locked(page)).toBeVisible();
  await setVisibility(page, "visible");
  await expect(page.locator("dialog.lock")).toHaveCount(1);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(locked(page)).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Path" })).toContainText("Friend's folder");
});

test("after 1 minute: stays open before, locks after", async ({ page }) => {
  await page.clock.install();
  await authenticator(page);
  await start(page);
  await turnOn(page, "After 1 minute");
  await setVisibility(page, "hidden");
  await page.clock.fastForward(30_000);
  await setVisibility(page, "visible");
  await expect(locked(page)).toBeHidden();
  await setVisibility(page, "hidden");
  await page.clock.fastForward(61_000);
  await setVisibility(page, "visible");
  await expect(locked(page)).toBeVisible();
});

test("stays off when Face ID fails while turning it on", async ({ page }) => {
  await authenticator(page, false);
  await start(page);
  await openSettings(page);
  await page.getByRole("radio", { name: "Immediately" }).click();
  await expect(page.getByRole("status")).toHaveText("App lock not turned on");
  await openSettings(page);
  await expect(page.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
});

test("a failed unlock stays locked, a later one works", async ({ page }) => {
  const setVerified = await authenticator(page);
  await start(page);
  await turnOn(page, "Immediately");
  await leaveAndReturn(page);
  await setVerified(false);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert")).toHaveText("Not unlocked. Try again.");
  await expect(locked(page)).toBeVisible();
  await setVerified(true);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(locked(page)).toBeHidden();
});

test("Escape does not unlock", async ({ page }) => {
  await authenticator(page);
  await start(page);
  await turnOn(page, "Immediately");
  await leaveAndReturn(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(locked(page)).toBeVisible();
});

test("a reload with Immediately starts locked", async ({ page }) => {
  await authenticator(page);
  await start(page);
  await turnOn(page, "Immediately");
  await page.reload();
  await expect(locked(page)).toBeVisible();
});

test("a cold start with no recorded leave time starts locked", async ({ page }) => {
  await authenticator(page);
  await start(page);
  await turnOn(page, "After 5 minutes");
  await page.addInitScript(() => localStorage.removeItem("lockHiddenAt")); // unload records it; drop it again
  await page.reload();
  await expect(locked(page)).toBeVisible();
});

test("Sign out on the lock screen removes links and the lock", async ({ page }) => {
  await authenticator(page);
  await start(page);
  await turnOn(page, "Immediately");
  await leaveAndReturn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).last().click();
  await expect(page.getByLabel("Share link")).toBeVisible();
  await expect(locked(page)).toBeHidden();
  await expect(page.getByText("Friend's folder")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("appLock"))).toBeNull();
});

test("a device without a lock says so", async ({ page }) => {
  await start(page);
  await openSettings(page);
  await expect(page.getByText("This device can't lock the app")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Immediately" })).toBeDisabled();
});

test("turning it off stops locking", async ({ page }) => {
  await authenticator(page);
  await start(page);
  await turnOn(page, "Immediately");
  await openSettings(page);
  await page.getByRole("radio", { name: "Off" }).click();
  await leaveAndReturn(page);
  await expect(locked(page)).toBeHidden();
});

test("visibility events during the Face ID prompt don't lock again", async ({ page }) => {
  await authenticator(page);
  await start(page);
  await turnOn(page, "Immediately");
  await leaveAndReturn(page);
  await page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    const fire = (s: string) => {
      Object.defineProperty(document, "visibilityState", { value: s, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    navigator.credentials.get = async (o) => {
      fire("hidden");
      const cred = await get(o);
      setTimeout(() => fire("visible"), 50); // the system sheet goes away after the app already unlocked
      return cred;
    };
  });
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(locked(page)).toBeHidden();
  await page.waitForTimeout(200); // let the late "visible" arrive
  await expect(page.locator("dialog.lock")).toHaveCount(0);
});
