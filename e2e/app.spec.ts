import { mkdirSync, writeFileSync } from "node:fs";
import { devices, expect, test, type Page } from "@playwright/test";
import { EDIT_LINK, VIEW_LINK, fakeOneDrive } from "./fakeOneDrive";

async function start(page: Page, link = EDIT_LINK, init?: () => void) {
  await page.addInitScript(() => (window.__TEST_TOKEN__ = "test-token"));
  if (init) await page.addInitScript(init);
  const drive = await fakeOneDrive(page);
  await page.goto("./");
  await page.getByLabel("Share link").fill(link);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("navigation", { name: "Path" })).toContainText("Friend's folder");
  return drive;
}
const actions = async (page: Page, name: string, action: string) => {
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: action }).click();
};
const toast = (page: Page) => page.getByRole("status");

test("shows a hint when the app has no client id", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByText("Not configured")).toBeVisible();
});

test.describe("share link", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => (window.__TEST_TOKEN__ = "test-token"));
    await fakeOneDrive(page);
    await page.goto("./");
  });
  for (const [link, message] of [
    ["https://example.com/x", "Not a OneDrive link"],
    ["https://1drv.ms/u/s!abc", "This is a file link, not a folder link"],
    ["https://1drv.ms/f/s!Unknown", "OneDrive rejected this link (expired or no access)"],
  ]) {
    test(`rejects ${link}`, async ({ page }) => {
      await page.getByLabel("Share link").fill(link);
      await page.getByRole("button", { name: "Open" }).click();
      await expect(page.getByRole("alert")).toHaveText(message);
    });
  }
  test("is remembered across reloads and can be changed", async ({ page }) => {
    await page.getByLabel("Share link").fill(EDIT_LINK);
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("button", { name: "readme.txt", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "readme.txt", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Change link" }).click();
    await expect(page.getByLabel("Share link")).toBeVisible();
  });
});

test("lists folders first and navigates with the breadcrumb", async ({ page }) => {
  await start(page);
  const names = page.getByRole("list", { name: "Items" }).getByRole("listitem");
  await expect(names).toHaveCount(3);
  await expect(names.nth(0)).toContainText("Alpha");
  await expect(names.nth(1)).toContainText("Beta");
  await expect(names.nth(2)).toContainText("readme.txt");
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(page.getByRole("button", { name: "Inner", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Path" }).getByRole("button", { name: "Friend's folder" }).click();
  await expect(page.getByRole("button", { name: "readme.txt", exact: true })).toBeVisible();
});

test("shows an error instead of a blank screen when listing fails", async ({ page }) => {
  const drive = await start(page);
  drive.state.failList = true;
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(toast(page)).toContainText("Server exploded");
  await expect(page.getByRole("navigation", { name: "Path" })).toBeVisible();
});

test("renames with validation and conflict handling", async ({ page }) => {
  await start(page);
  await actions(page, "readme.txt", "Rename");
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(name).toHaveValue("readme.txt");
  await name.fill("a:b");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("must not contain");
  await name.fill("Beta");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toContainText("'Beta' already exists");
  await actions(page, "readme.txt", "Rename");
  await page.getByRole("textbox", { name: "Name" }).fill("Prüfung #1 %.txt");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Prüfung #1 %.txt", exact: true })).toBeVisible();
});

test("creates a folder", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Gamma");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Gamma", exact: true })).toBeVisible();
});

test("deletes a folder with everything in it after confirmation", async ({ page }) => {
  const drive = await start(page);
  await actions(page, "Alpha", "Delete");
  await expect(page.getByRole("dialog")).toContainText("Delete 'Alpha' and everything in it?");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: "Alpha", exact: true })).toHaveCount(0);
  expect([...drive.nodes.values()].map((n) => n.name)).not.toContain("Inner");
});

test("cancelling delete keeps the item", async ({ page }) => {
  await start(page);
  await actions(page, "Alpha", "Delete");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Alpha", exact: true })).toBeVisible();
});

test("selects several items and deletes them", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("checkbox", { name: "Beta" }).check();
  await page.getByRole("checkbox", { name: "readme.txt" }).check();
  await page.getByRole("button", { name: "Delete (2)" }).click();
  await expect(page.getByRole("dialog")).toContainText("Delete 2 items?");
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1);
});

test("moves selected items into a sibling folder, never into themselves", async ({ page }) => {
  const drive = await start(page);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("checkbox", { name: "Alpha" }).check();
  await page.getByRole("checkbox", { name: "readme.txt" }).check();
  await page.getByRole("button", { name: "Move (2)" }).click();
  const picker = page.getByRole("dialog");
  await expect(picker.getByRole("button", { name: "Move here" })).toBeDisabled(); // current folder
  await expect(picker.getByRole("button", { name: "Alpha", exact: true })).toBeDisabled(); // a selected folder
  await picker.getByRole("button", { name: "Beta", exact: true }).click();
  await picker.getByRole("button", { name: "Move here" }).click();
  await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1);
  expect(drive.names("Beta")).toEqual(["Alpha", "readme.txt"]);
});

test("moves a single item via its menu", async ({ page }) => {
  const drive = await start(page);
  await actions(page, "readme.txt", "Move");
  await page.getByRole("dialog").getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move here" }).click();
  await expect(page.getByRole("button", { name: "readme.txt", exact: true })).toHaveCount(0);
  expect(drive.names("Alpha")).toContain("readme.txt");
});

test("uploads several files and reports the one that failed", async ({ page }) => {
  const drive = await start(page);
  drive.state.failUploadName = "bad.txt";
  await page.getByLabel("Upload files").setInputFiles([
    { name: "good.txt", mimeType: "text/plain", buffer: Buffer.from("ok") },
    { name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("no") },
  ]);
  await expect(page.getByRole("button", { name: "good.txt", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Uploads" })).toContainText("bad.txt: 'bad.txt' already exists");
});

test.describe("on a desktop browser", () => {
  const { defaultBrowserType: _, ...desktop } = devices["Desktop Chrome"];
  test.use(desktop);
  test("offers folder upload and recreates the folder tree", async ({ page }) => {
    const drive = await start(page);
    await expect(page.getByText("Upload folder")).toBeVisible();
    const dir = test.info().outputPath("Trip");
    mkdirSync(`${dir}/day1`, { recursive: true });
    writeFileSync(`${dir}/day1/a.jpg`, "a");
    writeFileSync(`${dir}/b.jpg`, "b");
    await page.getByLabel("Upload folder").setInputFiles(dir);
    await expect(page.getByRole("button", { name: "Trip", exact: true })).toBeVisible();
    expect(drive.names("Trip")).toEqual(["b.jpg", "day1"]);
    expect(drive.names("day1")).toEqual(["a.jpg"]);
  });
});

test("hides folder upload in the installed app", async ({ page }) => {
  await start(page, EDIT_LINK, () => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (q: string) =>
      q === "(display-mode: standalone)" ? ({ matches: true } as MediaQueryList) : orig(q);
  });
  await expect(page.getByText("Upload files")).toBeVisible();
  await expect(page.getByText("Upload folder")).toHaveCount(0);
});

test("view-only link hides all changes", async ({ page }) => {
  await start(page, VIEW_LINK);
  await expect(page.getByText("View-only link")).toBeVisible();
  await expect(page.getByRole("button", { name: /Actions for/ })).toHaveCount(0);
  await expect(page.getByText("New folder")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select" })).toHaveCount(0);
});
