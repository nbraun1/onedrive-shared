// Graph "shares" token: https://learn.microsoft.com/graph/api/shares-get#encoding-sharing-urls
export function encodeShareLink(url: string): string {
  const bytes = new TextEncoder().encode(url.trim());
  const b64 = btoa(String.fromCharCode(...bytes));
  return "u!" + b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function validateShareLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return "Not a OneDrive link";
  }
  if (url.protocol !== "https:" || !["1drv.ms", "onedrive.live.com"].includes(url.hostname)) return "Not a OneDrive link";
  if (url.hostname === "1drv.ms" && /^\/[uwxpbiv]\//.test(url.pathname)) return "This is a file link, not a folder link";
  return null;
}

export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Name must not be empty";
  if (n.length > 255) return "Name is too long (max 255 characters)";
  if (/["*:<>?/\\|]/.test(n)) return 'Name must not contain " * : < > ? / \\ |';
  if (n.endsWith(".")) return "Name must not end with a dot";
  return null;
}
