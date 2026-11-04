import { expect, it } from "vitest";
import { viewKind } from "./viewer";

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
