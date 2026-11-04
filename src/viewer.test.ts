import { expect, it } from "vitest";
import { readStart, viewKind } from "./viewer";

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
