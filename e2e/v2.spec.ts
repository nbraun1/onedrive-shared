import { devices, expect, test, type Page } from "@playwright/test";
import { EDIT_LINK, OTHER_LINK, THIRD_LINK, fakeOneDrive } from "./fakeOneDrive";

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

type Drive = Awaited<ReturnType<typeof fakeOneDrive>>;
async function gallery(page: Page, setup?: (state: Drive["state"]) => void) {
  const drive = await boot(page);
  setup?.(drive.state);
  await addLink(page, EDIT_LINK);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(page.getByRole("button", { name: "photo1.jpg", exact: true })).toBeVisible();
  return drive;
}
const viewer = (page: Page) => page.getByRole("dialog", { name: "Viewer" });
const original = (page: Page) => viewer(page).locator(".slide.current img.original");

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
    await expect(original(page)).toHaveAttribute("src", /photo1\.jpg\?l=1$/);
    expect(drive.state.itemGets).toBe(0); // the listing already carried the download URL
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
    expect(drive.state.dlRequests.find((r) => r.url.includes("notes.txt"))!.range).toBe("bytes=0-1048575");
  });

  test("a video the browser cannot play shows a way out", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
    await expect(viewer(page)).toContainText("Can't show this file here");
    await expect(viewer(page).getByRole("button", { name: "Open in OneDrive" }).first()).toBeVisible();
  });

  test("a failing download URL keeps the preview and says why", async ({ page }) => {
    await gallery(page, (s) => ((s.listingUrls = false), (s.failDownloadUrl = true)));
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page).locator(".slide.current")).toContainText("Showing preview");
    await expect(viewer(page).locator(".slide.current")).toContainText("OneDrive error 500");
    await expect(viewer(page).locator(".slide.current img.preview")).toBeVisible();
  });

  test("files the browser cannot show open in OneDrive", async ({ page }) => {
    await gallery(page);
    const opened = page.context().waitForEvent("request", (r) => r.url().startsWith("https://onedrive.example/"));
    await page.getByRole("button", { name: "doc.pdf", exact: true }).click();
    await opened;
    await expect(viewer(page)).toHaveCount(0);
  });

  test("fast stepping ends on the right file", async ({ page }) => {
    await gallery(page, (s) => ((s.listingUrls = false), (s.dlDelayMs = 400)));
    await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
    await expect(viewer(page)).toContainText("1 / 5");
    await viewer(page).getByRole("button", { name: "Next" }).click();
    await viewer(page).getByRole("button", { name: "Next" }).click();
    await expect(viewer(page)).toContainText("3 / 5");
    await expect(original(page)).toHaveAttribute("src", /photo1\.jpg/);
    await page.waitForTimeout(1000);
    await expect(original(page)).toHaveAttribute("src", /photo1\.jpg/);
    await expect(viewer(page).locator(".slide.current pre")).toHaveCount(0);
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
    const drive = await gallery(page, (s) => ((s.listingUrls = false), (s.dlDelayMs = 800)));
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page).getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(original(page)).toBeVisible();
    drive.state.dlDelayMs = 0;
    await page.waitForTimeout(1000); // neighbours finish resolving their URLs
    const before = drive.state.itemGets;
    await viewer(page).getByRole("button", { name: "Save" }).click();
    await expect(viewer(page).getByRole("button", { name: "Save / Share" })).toBeVisible();
    expect(drive.state.itemGets).toBe(before + 1); // Save asked for a fresh URL
    expect(drive.state.dlRequests.some((r) => r.url.includes(`photo1.jpg?v=${drive.state.dlCalls}`))).toBe(true);
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

test.describe("viewer error details", () => {
  test("shows OneDrive's error for the download link", async ({ page }) => {
    const drive = await gallery(page, (s) => (s.listingUrls = false));
    drive.state.dlResponse = { status: 400, body: { error: { code: "invalidRequest", message: "Invalid select" } } };
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page)).toContainText("Download link: OneDrive error 400 (invalidRequest): Invalid select");
  });
  test("says which fields came back when a video has no download address", async ({ page }) => {
    const drive = await gallery(page, (s) => (s.listingUrls = false));
    drive.state.dlResponse = { status: 200, body: { id: "x", name: "clip.mp4" } };
    await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
    await expect(viewer(page)).toContainText("Download link: OneDrive returned no download address (fields: id, name)");
  });
  test("asks OneDrive for a preview when the listing has none and there is no download address", async ({ page }) => {
    const drive = await gallery(page, (s) => ((s.listingUrls = false), (s.noThumbs = true)));
    drive.state.dlResponse = { status: 200, body: { id: "x" } };
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page).locator(".slide.current img.preview")).toHaveAttribute("src", /^https:\/\/thumb\.example\/.*size=2048$/);
    await expect(viewer(page)).toContainText("Showing preview");
  });
  test("says when a video cannot be played", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
    await expect(viewer(page)).toContainText("Video could not be played");
  });
});

test.describe("reorder links", () => {
  async function threeLinks(page: Page) {
    await boot(page);
    for (const [link, name] of [[EDIT_LINK, "A"], [OTHER_LINK, "B"], [THIRD_LINK, "C"]]) {
      await addLink(page, link, name);
      await expect(crumbs(page)).toContainText(name);
      await openLinks(page);
    }
  }
  const order = (page: Page) => links(page).locator(".name").evaluateAll((els) => els.map((e) => e.firstChild!.textContent));
  async function drag(page: Page, label: string, toY: (box: { y: number; height: number }) => number, target: string) {
    const handle = (await page.getByRole("button", { name: `Reorder ${label}` }).boundingBox())!;
    const dest = (await page.getByRole("button", { name: target, exact: true }).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, toY(dest), { steps: 8 });
    await page.mouse.up();
  }

  test("drags a link to the top and keeps the order", async ({ page }) => {
    await threeLinks(page);
    expect(await order(page)).toEqual(["A", "B", "C"]);
    await drag(page, "C", (b) => b.y + 2, "A");
    await expect.poll(() => order(page)).toEqual(["C", "A", "B"]);
    await page.reload();
    await openLinks(page);
    expect(await order(page)).toEqual(["C", "A", "B"]);
    await page.getByRole("button", { name: "B", exact: true }).click();
    await expect(crumbs(page)).toContainText("B");
  });

  test("dropping in place keeps the order", async ({ page }) => {
    await threeLinks(page);
    await drag(page, "B", (b) => b.y + b.height / 2, "B");
    await page.waitForTimeout(200);
    expect(await order(page)).toEqual(["A", "B", "C"]);
  });

  test("drags a link down", async ({ page }) => {
    await threeLinks(page);
    await drag(page, "A", (b) => b.y + b.height - 2, "C");
    await expect.poll(() => order(page)).toEqual(["B", "C", "A"]);
  });
});

test("tapping a reorder handle keeps what you typed", async ({ page }) => {
  await boot(page);
  await addLink(page, EDIT_LINK, "A");
  await openLinks(page);
  await page.getByLabel("Share link").fill("https://1drv.ms/f/s!typed");
  const handle = (await page.getByRole("button", { name: "Reorder A" }).boundingBox())!;
  await page.mouse.move(handle.x + 5, handle.y + 5);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByLabel("Share link")).toHaveValue("https://1drv.ms/f/s!typed");
});

test.describe("viewer layout", () => {
  const noOverflow = (page: Page) =>
    viewer(page).evaluate((d) => ({
      v: d.scrollHeight - d.clientHeight,
      h: d.scrollWidth - d.clientWidth,
      bottom: Math.round(d.querySelector(".stage")!.getBoundingClientRect().bottom - window.innerHeight),
    }));
  for (const [name, desktop] of [["photo2.png", false], ["photo2.png", true], ["song.wav", false]] as const) {
    test(`${name} fits the screen without scrolling${desktop ? " (desktop)" : ""}`, async ({ page }) => {
      if (desktop) await page.setViewportSize({ width: 1280, height: 720 });
      await gallery(page);
      await page.getByRole("button", { name, exact: true }).click();
      if (name.endsWith(".png")) await expect.poll(() => original(page).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
      else await expect(viewer(page).locator("audio")).toBeVisible();
      expect(await noOverflow(page)).toEqual({ v: 0, h: 0, bottom: expect.any(Number) });
      expect((await noOverflow(page)).bottom).toBeLessThanOrEqual(0);
    });
  }
});

test("the folder page behind the viewer does not scroll", async ({ page }) => {
  await boot(page);
  await addLink(page, EDIT_LINK);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Many", exact: true }).click();
  await page.getByRole("button", { name: "img10.jpg", exact: true }).click();
  await expect(viewer(page)).toContainText("1 / 40");
  const scrollable = () => page.evaluate(() => document.documentElement.scrollHeight > innerHeight && getComputedStyle(document.documentElement).overflowY !== "hidden");
  expect(await scrollable()).toBe(false);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  expect(await scrollable()).toBe(true);
});

test.describe("fast viewer", () => {
  const slides = (page: Page) => viewer(page).locator(".slide");
  async function drag(page: Page, fraction: number) {
    const box = (await viewer(page).locator(".stage").boundingBox())!;
    const y = box.y + box.height / 2;
    const x = box.x + box.width * 0.8;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - box.width * fraction, y, { steps: 6 });
    await page.mouse.up();
  }

  test("shows the preview instantly, then the original", async ({ page }) => {
    await gallery(page, (s) => (s.dlFileDelayMs = 1500));
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page).locator(".slide.current img.preview")).toHaveAttribute("src", /s=large$/, { timeout: 1000 });
    await expect(viewer(page).locator(".slide.current img.preview")).toBeVisible({ timeout: 1000 });
    await expect(viewer(page).locator(".slide.current img.preview")).toHaveCount(0, { timeout: 5000 });
    await expect(original(page)).toBeVisible();
  });

  test("preloads nearby photos but not videos, audio or text", async ({ page }) => {
    const drive = await gallery(page);
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect.poll(() => drive.state.dlRequests.some((r) => r.url.includes("photo2.png"))).toBe(true);
    const fetched = drive.state.dlRequests.map((r) => r.url);
    for (const name of ["clip.mp4", "notes.txt", "song.wav"]) expect(fetched.some((u) => u.includes(name))).toBe(false);
  });

  test("falls back to asking OneDrive when the listing has no download URL", async ({ page }) => {
    const drive = await gallery(page, (s) => (s.listingUrls = false));
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(original(page)).toHaveAttribute("src", /\?v=\d+$/);
    expect(drive.state.itemGets).toBeGreaterThan(0);
    await page.keyboard.press("ArrowRight");
    await expect(viewer(page)).toContainText("4 / 5");
    await page.waitForTimeout(300);
    const after = drive.state.itemGets;
    await page.keyboard.press("ArrowLeft");
    await expect(viewer(page)).toContainText("3 / 5");
    await page.waitForTimeout(300);
    expect(drive.state.itemGets).toBe(after);
  });

  test("asks OneDrive again when the listing is older than 50 minutes", async ({ page }) => {
    await page.clock.install();
    const drive = await gallery(page);
    await page.clock.fastForward("51:00");
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(original(page)).toHaveAttribute("src", /\?v=\d+$/);
    expect(drive.state.itemGets).toBeGreaterThan(0);
  });

  test("keeps the preview when the original fails", async ({ page }) => {
    await gallery(page, (s) => (s.failOriginal = "photo1.jpg"));
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page).locator(".slide.current")).toContainText("Showing preview");
    await expect(viewer(page).locator(".slide.current img.preview")).toBeVisible();
  });

  test("a short drag snaps back, a long one moves on", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page)).toContainText("3 / 5");
    await drag(page, 0.1);
    await page.waitForTimeout(400);
    await expect(viewer(page)).toContainText("3 / 5");
    await drag(page, 0.6);
    await expect(viewer(page)).toContainText("4 / 5");
    expect(await slides(page).count()).toBeLessThanOrEqual(3);
  });

  test("a big folder keeps at most three slides", async ({ page }) => {
    await boot(page);
    await addLink(page, EDIT_LINK);
    await page.getByRole("button", { name: "Alpha", exact: true }).click();
    await page.getByRole("button", { name: "Many", exact: true }).click();
    await page.getByRole("button", { name: "img20.jpg", exact: true }).click();
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
    await expect(viewer(page)).toContainText("17 / 40");
    expect(await slides(page).count()).toBeLessThanOrEqual(3);
  });

  test("videos show a still at once and audio stops when swiped away", async ({ page }) => {
    await gallery(page);
    // the test clip is unplayable, so check it as the not-yet-loaded neighbour of notes.txt
    await page.getByRole("button", { name: "notes.txt", exact: true }).click();
    const neighbour = viewer(page).locator(".slide:not(.current) video");
    await expect(neighbour).toHaveAttribute("poster", /s=large$/);
    await expect(neighbour).toHaveJSProperty("preload", "none");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "song.wav", exact: true }).click();
    const audio = viewer(page).locator(".slide.current audio");
    await expect(audio).toBeVisible();
    await audio.evaluate((a: HTMLAudioElement) => a.play().catch(() => {}));
    await page.keyboard.press("ArrowLeft");
    await expect(viewer(page)).toContainText("4 / 5");
    await expect.poll(() => viewer(page).locator("audio").evaluateAll((els) => els.every((a) => (a as HTMLAudioElement).paused))).toBe(true);
  });
});

test.describe("fast viewer review fixes", () => {
  async function many(page: Page, setup?: (s: Drive["state"]) => void) {
    const drive = await boot(page);
    setup?.(drive.state);
    await addLink(page, EDIT_LINK);
    await page.getByRole("button", { name: "Alpha", exact: true }).click();
    await page.getByRole("button", { name: "Many", exact: true }).click();
    await page.getByRole("button", { name: "img20.jpg", exact: true }).click();
    return drive;
  }
  const fetchedNames = (drive: Drive) => drive.state.dlRequests.map((r) => decodeURIComponent(new URL(r.url).pathname.split("/").pop()!));

  test("closing during the slide animation loads nothing more", async ({ page }) => {
    const drive = await many(page);
    await expect(viewer(page)).toContainText("11 / 40");
    await page.waitForTimeout(300);
    await viewer(page).getByRole("button", { name: "Next" }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    expect(fetchedNames(drive)).not.toContain("img23.jpg");
  });

  test("slides dropped while their URL was loading do not download", async ({ page }) => {
    const drive = await many(page, (s) => ((s.listingUrls = false), (s.dlDelayMs = 500)));
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
    await expect(viewer(page)).toContainText("15 / 40");
    await page.waitForTimeout(2000);
    const names = fetchedNames(drive);
    for (const gone of ["img18.jpg", "img19.jpg", "img20.jpg", "img21.jpg"]) expect(names).not.toContain(gone);
    expect(names).toContain("img24.jpg");
  });

  test("a cached URL older than 50 minutes is fetched again", async ({ page }) => {
    await page.clock.install();
    const drive = await gallery(page);
    await page.getByRole("button", { name: "song.wav", exact: true }).click();
    await expect(viewer(page)).toContainText("5 / 5");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await expect(viewer(page)).toContainText("2 / 5");
    await page.clock.fastForward("51:00");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(viewer(page)).toContainText("5 / 5");
    await expect(viewer(page).locator(".slide.current audio")).toHaveAttribute("src", /\?v=\d+$/);
    expect(drive.state.itemGets).toBeGreaterThan(0);
  });

  test("Save stays usable when the download link failed", async ({ page }) => {
    await gallery(page, (s) => ((s.listingUrls = false), (s.failDownloadUrl = true)));
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page).locator(".slide.current")).toContainText("Showing preview");
    await expect(viewer(page).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  test("off-screen slides are hidden from screen readers", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    await expect(viewer(page).locator(".slide[inert]")).toHaveCount(2);
    await expect(viewer(page).locator(".slide.current")).not.toHaveAttribute("inert");
  });

  test("a drag released outside the photo still completes", async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: "photo1.jpg", exact: true }).click();
    const box = (await viewer(page).locator(".stage").boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.8, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, y, { steps: 6 });
    await page.mouse.move(box.x + box.width * 0.2, box.y - 40, { steps: 3 }); // over the top bar
    await page.mouse.up();
    await expect(viewer(page)).toContainText("4 / 5");
  });
});
