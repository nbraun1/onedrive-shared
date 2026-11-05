import { expect, it } from "vitest";
import { listingUrl, previewUrl, readStart, slideWindow, viewKind } from "./viewer";
import { describe } from "vitest";

it.each([
  [{ name: "IMG_0001.HEIC", file: {} }, "image"],
  [{ name: "clip.MOV", file: {} }, "video"],
  [{ name: "song.m4a", file: {} }, "audio"],
  [{ name: "notes.MD", file: {} }, "text"],
  [{ name: "x", file: { mimeType: "image/png" } }, "image"],
  [{ name: "x", file: { mimeType: "video/mp4" } }, "video"],
  [{ name: "report.pdf", file: { mimeType: "application/pdf" } }, null],
  [{ name: "Photos", folder: {} }, null],
  [{ name: "README", file: {} }, null],
])("%j → %s", (item, kind) => {
  expect(viewKind({ id: "1", ...item })).toBe(kind);
});

it("reads only the start of a large text body and stops the download", async () => {
  const chunk = new Uint8Array(512 * 1024).fill(65);
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const { text, cut } = await readStart(new Response(body), 1024 * 1024);
  expect(text.length).toBe(1024 * 1024);
  expect(cut).toBe(true);
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThanOrEqual(4);
});

it("reads a small text body completely", async () => {
  expect(await readStart(new Response("hi ü"), 1024)).toEqual({ text: "hi ü", cut: false });
});

describe("listingUrl", () => {
  const item = { id: "1", name: "a.jpg", "@microsoft.graph.downloadUrl": "https://dl/new" };
  const MIN = 60_000;
  it("uses the listing URL while it is fresh", () => expect(listingUrl(item, 0, 49 * MIN)).toBe("https://dl/new"));
  it("drops it after 50 minutes", () => expect(listingUrl(item, 0, 50 * MIN)).toBeNull());
  it("accepts the older name", () => expect(listingUrl({ id: "1", name: "a", "@content.downloadUrl": "https://dl/old" }, 0, 0)).toBe("https://dl/old"));
  it("returns null without one", () => expect(listingUrl({ id: "1", name: "a" }, 0, 0)).toBeNull());
});

describe("previewUrl", () => {
  const t = (s: string) => ({ url: `https://t/${s}` });
  it("prefers large, then medium, then small", () => {
    expect(previewUrl({ id: "1", name: "a", thumbnails: [{ small: t("s"), medium: t("m"), large: t("l") }] })).toBe("https://t/l");
    expect(previewUrl({ id: "1", name: "a", thumbnails: [{ small: t("s"), medium: t("m") }] })).toBe("https://t/m");
    expect(previewUrl({ id: "1", name: "a", thumbnails: [{ small: t("s") }] })).toBe("https://t/s");
  });
  it("returns null without thumbnails", () => {
    expect(previewUrl({ id: "1", name: "a" })).toBeNull();
    expect(previewUrl({ id: "1", name: "a", thumbnails: [] })).toBeNull();
  });
});

describe("slideWindow", () => {
  it.each([
    [0, 5, [0, 1, 2]],
    [4, 5, [2, 3, 4]],
    [2, 5, [0, 1, 2, 3, 4]],
    [5, 10, [3, 4, 5, 6, 7]],
    [0, 1, [0]],
  ])("index %i of %i → %j", (index, count, expected) => expect(slideWindow(index, count)).toEqual(expected));
  it("takes a radius", () => expect(slideWindow(5, 10, 1)).toEqual([4, 5, 6]));
});
