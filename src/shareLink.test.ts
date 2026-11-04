import { describe, expect, it } from "vitest";
import { encodeShareLink, validateName, validateShareLink } from "./shareLink";

describe("encodeShareLink", () => {
  it("encodes as u! + unpadded base64url", () => {
    expect(encodeShareLink("https://1drv.ms/f/s!abc")).toBe("u!aHR0cHM6Ly8xZHJ2Lm1zL2YvcyFhYmM");
  });
  it("replaces + and / and strips padding", () => {
    expect(encodeShareLink("https://1drv.ms/f/s!a??>")).toBe("u!aHR0cHM6Ly8xZHJ2Lm1zL2YvcyFhPz8-");
    expect(encodeShareLink("https://1drv.ms/f/s!ÿÿ")).toBe("u!aHR0cHM6Ly8xZHJ2Lm1zL2YvcyHDv8O_");
    expect(encodeShareLink("https://1drv.ms/f/s!a?>")).toBe("u!aHR0cHM6Ly8xZHJ2Lm1zL2YvcyFhPz4");
  });
  it("trims surrounding whitespace", () => {
    expect(encodeShareLink("  https://1drv.ms/f/s!abc\n")).toBe("u!aHR0cHM6Ly8xZHJ2Lm1zL2YvcyFhYmM");
  });
});

describe("validateShareLink", () => {
  it.each([
    "https://1drv.ms/f/c/1a2b3c4d5e6f7a8b/EkTqXyZ12AbCdEf",
    "https://1drv.ms/f/s!AmBcDeFgHiJkLmNoPq1234567",
    "https://onedrive.live.com/?redeem=aHR0cHM6Ly8xZHJ2&id=ABC",
    "  https://1drv.ms/f/s!Abc  ",
  ])("accepts folder link %s", (link) => {
    expect(validateShareLink(link)).toBeNull();
  });
  it.each(["", "   ", "not a url", "https://google.com/f/s!x", "http://1drv.ms/f/s!x", "https://evil.com/?u=https://1drv.ms/f/s!x"])(
    "rejects non-OneDrive %j",
    (link) => {
      expect(validateShareLink(link)).toBe("Not a OneDrive link");
    },
  );
  it.each(["https://1drv.ms/u/s!x", "https://1drv.ms/w/c/abc/def", "https://1drv.ms/x/s!x", "https://1drv.ms/i/s!x"])(
    "rejects file link %s",
    (link) => {
      expect(validateShareLink(link)).toBe("This is a file link, not a folder link");
    },
  );
});

describe("validateName", () => {
  it.each(["", "   ", "a:b", "a/b", "a\\b", 'a"b', "a*b", "a?b", "a<b", "a>b", "a|b", "a.", "x".repeat(256)])(
    "rejects %j",
    (name) => {
      expect(validateName(name)).not.toBeNull();
    },
  );
  it.each(["Prüfung #1 %", "x".repeat(255), "photo.jpg", "  padded  "])("accepts %j", (name) => {
    expect(validateName(name)).toBeNull();
  });
});
