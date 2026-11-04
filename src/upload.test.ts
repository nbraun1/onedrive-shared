import { describe, expect, it, vi } from "vitest";
import { GraphError, type Graph } from "./graph";
import { uploadMany } from "./upload";

const file = (path: string) => {
  const name = path.split("/").pop()!;
  const f = new File(["x"], name);
  if (path.includes("/")) Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
};

function fakeGraph(opts: { failUpload?: string; failFolder?: string } = {}) {
  let n = 0;
  const createFolder = vi.fn(async (_d: string, parent: string, name: string) => {
    if (name === opts.failFolder) throw new GraphError(409, "nameAlreadyExists", "exists");
    return { id: `${parent}/${name}#${++n}`, name };
  });
  const uploadFile = vi.fn(async (_d: string, parent: string, f: File, onProgress?: (x: number) => void) => {
    if (f.name === opts.failUpload) throw new GraphError(409, "nameAlreadyExists", "exists");
    onProgress?.(1);
    return { id: `${parent}/${f.name}`, name: f.name };
  });
  return { graph: { createFolder, uploadFile } as unknown as Graph, createFolder, uploadFile };
}

describe("uploadMany", () => {
  it("uploads plain files into the parent", async () => {
    const g = fakeGraph();
    const failures = await uploadMany(g.graph, "d", "P", [file("a.txt"), file("b.txt")], () => {});
    expect(failures).toEqual([]);
    expect(g.uploadFile.mock.calls.map((c) => [c[1], c[2].name])).toEqual([
      ["P", "a.txt"],
      ["P", "b.txt"],
    ]);
    expect(g.createFolder).not.toHaveBeenCalled();
  });

  it("recreates a folder tree once per folder, top-down", async () => {
    const g = fakeGraph();
    const progress = vi.fn();
    const files = [file("top/x.txt"), file("top/sub/y.txt"), file("top/sub/z.txt")];
    expect(await uploadMany(g.graph, "d", "P", files, progress)).toEqual([]);
    expect(g.createFolder.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["P", "top"],
      ["P/top#1", "sub"],
    ]);
    expect(g.uploadFile.mock.calls.map((c) => [c[1], c[2].name])).toEqual([
      ["P/top#1", "x.txt"],
      ["P/top#1/sub#2", "y.txt"],
      ["P/top#1/sub#2", "z.txt"],
    ]);
    expect(progress).toHaveBeenCalledWith(files[0], 1);
  });

  it("keeps going when one upload fails and reports it", async () => {
    const g = fakeGraph({ failUpload: "b.txt" });
    const files = [file("a.txt"), file("b.txt"), file("c.txt")];
    const failures = await uploadMany(g.graph, "d", "P", files, () => {});
    expect(failures).toEqual([{ file: files[1], error: "'b.txt' already exists" }]);
    expect(g.uploadFile).toHaveBeenCalledTimes(3);
  });

  it("fails the files of a folder that could not be created, siblings continue", async () => {
    const g = fakeGraph({ failFolder: "bad" });
    const files = [file("top/bad/1.txt"), file("top/bad/deep/2.txt"), file("top/ok.txt")];
    const failures = await uploadMany(g.graph, "d", "P", files, () => {});
    expect(failures.map((f) => [f.file.name, f.error])).toEqual([
      ["1.txt", "'bad' already exists"],
      ["2.txt", "'bad' already exists"],
    ]);
    expect(g.uploadFile.mock.calls.map((c) => c[2].name)).toEqual(["ok.txt"]);
  });

  it("handles an empty selection", async () => {
    expect(await uploadMany(fakeGraph().graph, "d", "P", [], () => {})).toEqual([]);
  });
});
