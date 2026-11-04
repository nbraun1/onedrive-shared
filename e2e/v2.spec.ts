import { devices, expect, test, type Page } from "@playwright/test";
import { EDIT_LINK, OTHER_LINK, fakeOneDrive } from "./fakeOneDrive";

async function boot(page: Page, init?: () => void) {
  await page.addInitScript(() => (window.__TEST_TOKEN__ = "test-token"));
  if (init) await page.addInitScript(init);
  const drive = await fakeOneDrive(page);
  await page.goto("./");
  return drive;
}
async function addLink(page: Page, link: string, name = "") {
  await page.getByLabel("Link name").fill(name);
  await page.getByLabel("Share link").fill(link);
  await page.getByRole("button", { name: "Add" }).click();
}
const crumbs = (page: Page) => page.getByRole("navigation", { name: "Path" });
const openLinks = async (page: Page) => {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Links" }).click();
};
const links = (page: Page) => page.getByRole("list", { name: "Saved links" }).getByRole("listitem");

test.describe("saved links", () => {
  test("adds, names, switches, renames and removes links", async ({ page }) => {
    await boot(page);
    await expect(page.getByRole("heading", { name: "Links" })).toBeVisible();
    await addLink(page, EDIT_LINK, "Urlaub");
    await expect(crumbs(page)).toContainText("Urlaub");
    await openLinks(page);
    await addLink(page, OTHER_LINK);
    await expect(crumbs(page)).toContainText("Beta");
    await openLinks(page);
    await expect(links(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Urlaub", exact: true }).click();
    await expect(page.getByRole("button", { name: "readme.txt", exact: true })).toBeVisible();

    await openLinks(page);
    await page.getByRole("button", { name: "Actions for Urlaub" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Ferien");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Ferien", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Actions for Beta" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("dialog")).toContainText("Remove 'Beta'? Files in OneDrive are not affected.");
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await expect(links(page)).toHaveCount(1);

    await addLink(page, EDIT_LINK, "Again");
    await expect(page.getByRole("status")).toContainText("Already saved as 'Ferien'");
    await openLinks(page);
    await expect(links(page)).toHaveCount(1);
  });

  test("reopens the last link after a reload", async ({ page }) => {
    await boot(page);
    await addLink(page, OTHER_LINK, "Second");
    await expect(crumbs(page)).toContainText("Second");
    await page.reload();
    await expect(crumbs(page)).toContainText("Second");
  });

  test("removing the open link returns to the list", async ({ page }) => {
    await boot(page);
    await addLink(page, EDIT_LINK, "Only");
    await openLinks(page);
    await page.getByRole("button", { name: "Actions for Only" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("No saved links yet")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Links" })).toBeVisible();
  });

  test("migrates the link saved by the previous version", async ({ page }) => {
    await boot(page, () =>
      localStorage.setItem("share", JSON.stringify({ driveId: "D", itemId: "n1", name: "Friend's folder", canEdit: true })),
    );
    await expect(page.getByRole("button", { name: "Friend's folder", exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("share"))).toBeNull();
  });

  test("rejects a name longer than 60 characters", async ({ page }) => {
    await boot(page);
    await addLink(page, EDIT_LINK, "x".repeat(61));
    await expect(page.getByRole("alert")).toHaveText("Name is too long (max 60 characters)");
  });
});

async function gallery(page: Page) {
  const drive = await boot(page);
  await addLink(page, EDIT_LINK);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(page.getByRole("button", { name: "photo1.jpg", exact: true })).toBeVisible();
  return drive;
}
const viewer = (page: Page) => page.getByRole("dialog", { name: "Viewer" });

test("shows thumbnails for files, not for folders", async ({ page }) => {
  await boot(page);
  await addLink(page, EDIT_LINK);
  const readme = page.getByRole("listitem").filter({ hasText: "readme.txt" });
  await expect(readme.locator("img")).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: "Alpha" }).locator("img")).toHaveCount(0);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "photo1.jpg" }).locator("img")).toHaveAttribute("src", /^https:\/\/thumb\.example\//);
});

test.describe("viewer", () => {
  test("shows images with a fresh download URL and steps through files", async ({ page }) => {
    const drive = await gallery(page);
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page)).toContainText("3 / 5");
    const img = viewer(page).locator("img");
    await expect(img).toHaveAttribute("src", new RegExp(`photo1\\.jpg\\?v=${drive.state.dlCalls}$`));
    await viewer(page).getByRole("button", { name: "Next" }).click();
    await expect(viewer(page)).toContainText("photo2.png");
    await expect(viewer(page)).toContainText("4 / 5");
    await page.keyboard.press("ArrowRight");
    await expect(viewer(page)).toContainText("5 / 5");
    await expect(viewer(page).getByRole("button", { name: "Next" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
  });

  test("swipes to the previous file", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "photo2.png", exact: true }).click();
    await expect(viewer(page)).toContainText("4 / 5");
    const box = (await viewer(page).locator(".stage").boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 50, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, y, { steps: 5 });
    await page.mouse.up();
    await expect(viewer(page)).toContainText("3 / 5");
  });

  test("ignores swipes on the audio controls", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "song.wav", exact: true }).click();
    const audio = viewer(page).locator("audio");
    await expect(audio).toBeVisible();
    const box = (await audio.boundingBox())!;
    const y = box.y + box.height * 0.9;
    await page.mouse.move(box.x + box.width - 20, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 20, y, { steps: 5 });
    await page.mouse.up();
    await expect(viewer(page)).toContainText("5 / 5");
  });

  test("first file has no previous", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
    await expect(viewer(page)).toContainText("1 / 5");
    await expect(viewer(page).getByRole("button", { name: "Previous" })).toBeDisabled();
  });

  test("shows text files, reading only the first megabyte", async ({ page }) => {
    const drive = await gallery(page);
    await page.getByRole("button", { name: "notes.txt", exact: true }).click();
    await expect(viewer(page).locator("pre")).toHaveText("Hello from notes");
    expect(drive.state.dlRequests.at(-1)!.range).toBe("bytes=0-1048575");
  });

  test("a video the browser cannot play shows a way out", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
    await expect(viewer(page)).toContainText("Can't show this file here");
    await expect(viewer(page).getByRole("button", { name: "Open in OneDrive" }).first()).toBeVisible();
  });

  test("a failing download URL shows a way out", async ({ page }) => {
    const drive = await gallery(page);
    drive.state.failDownloadUrl = true;
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page)).toContainText("Can't show this file here");
  });

  test("files the browser cannot show open in OneDrive", async ({ page }) => {
    await gallery(page);
    const opened = page.context().waitForEvent("request", (r) => r.url().startsWith("https://onedrive.example/"));
    await page.getByRole("button", { name: "doc.pdf", exact: true }).click();
    await opened;
    await expect(viewer(page)).toHaveCount(0);
  });

  test("fast stepping ends on the right file", async ({ page }) => {
    const drive = await gallery(page);
    await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
    await expect(viewer(page)).toContainText("1 / 5");
    drive.state.dlDelayMs = 800;
    await viewer(page).getByRole("button", { name: "Next" }).click();
    await viewer(page).getByRole("button", { name: "Next" }).click();
    await expect(viewer(page)).toContainText("3 / 5");
    await expect(viewer(page).locator("img")).toHaveAttribute("src", /photo1\.jpg/);
    await page.waitForTimeout(1000);
    await expect(viewer(page).locator("img")).toHaveAttribute("src", /photo1\.jpg/);
    await expect(viewer(page).locator("pre")).toHaveCount(0);
  });

  test("big files are saved through the download URL directly", async ({ page }) => {
    const drive = await gallery(page);
    await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
    await expect(viewer(page)).toContainText("Can't show this file here");
    const before = drive.state.dlRequests.length;
    const opened = page.context().waitForEvent("request", (r) => /^https:\/\/dl\.example\/.*clip\.mp4/.test(r.url()));
    await viewer(page).getByRole("button", { name: "Save" }).click();
    await opened;
    expect(drive.state.dlRequests.length).toBe(before); // no in-memory download of the 300 MB file
  });
});

test.describe("viewer on a desktop browser", () => {
  const { defaultBrowserType: _, ...desktop } = devices["Desktop Chrome"];
  test.use(desktop);
  test("saves a file as a download", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await viewer(page).getByRole("button", { name: "Save" }).click();
    const download = page.waitForEvent("download");
    await viewer(page).getByRole("button", { name: "Save / Share" }).click();
    expect((await download).suggestedFilename()).toBe("photo1.jpg");
  });
});

test.describe("viewer review fixes", () => {
  test("Save waits for the file and uses a fresh download URL", async ({ page }) => {
    const drive = await gallery(page);
    drive.state.dlDelayMs = 800;
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page).getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(viewer(page).locator("img")).toBeVisible();
    drive.state.dlDelayMs = 0;
    const shown = drive.state.dlCalls;
    await viewer(page).getByRole("button", { name: "Save" }).click();
    await expect(viewer(page).getByRole("button", { name: "Save / Share" })).toBeVisible();
    expect(drive.state.dlRequests.at(-1)!.url).toContain(`?v=${shown + 1}`);
  });

  test("a second finger does not count as a swipe", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "photo2.png", exact: true }).click();
    await expect(viewer(page)).toContainText("4 / 5");
    await viewer(page).locator(".stage").evaluate((stage) => {
      const r = stage.getBoundingClientRect();
      const y = r.top + r.height / 2;
      stage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: false, clientX: r.left + 200, clientY: y }));
      stage.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: false, clientX: r.left + 20, clientY: y }));
    });
    await page.waitForTimeout(300);
    await expect(viewer(page)).toContainText("4 / 5");
  });
});
