import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const validUploadUrl = "http://192.168.1.25:8081/upload?t=receiver-secret";

async function createPair(uploadUrl = validUploadUrl) {
  const response = await SELF.fetch("https://pair.test/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadUrl }),
  });
  return { response, body: await response.json<Record<string, unknown>>() };
}

async function createDownloadPair(downloadUrl = "http://192.168.1.25:8080/?t=sender-secret") {
  const response = await SELF.fetch("https://pair.test/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ downloadUrl }),
  });
  return { response, body: await response.json<Record<string, unknown>>() };
}

describe("GoodFile pairing Worker", () => {
  it("creates a four-digit, five-minute code that can retry the LAN redirect", async () => {
    const { response, body } = await createPair();
    expect(response.status).toBe(201);
    expect(body.code).toMatch(/^\d{4}$/);
    expect(body.ownerSecret).toMatch(/^[a-f0-9]{48}$/);
    expect(Number(body.expiresAt)).toBeGreaterThan(Date.now() + 4 * 60 * 1000);

    const first = await SELF.fetch(`https://pair.test/${body.code}`, { redirect: "manual" });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Android found");

    const second = await SELF.fetch(`https://pair.test/${body.code}`, { redirect: "manual" });
    expect(second.status).toBe(200);
    const secondPage = await second.text();
    expect(secondPage).toContain("Open file receiver");
    expect(secondPage).toContain(validUploadUrl.replace("&", "&amp;"));
  });

  it("reports claim status only to the Android owner", async () => {
    const { body } = await createPair();
    const endpoint = `https://pair.test/api/pair/${body.code}`;
    const waiting = await SELF.fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ action: "status", ownerSecret: body.ownerSecret }),
    });
    expect(await waiting.json()).toEqual({ status: "waiting" });

    await SELF.fetch(`https://pair.test/${body.code}`, { redirect: "manual" });
    const claimed = await SELF.fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ action: "status", ownerSecret: body.ownerSecret }),
    });
    expect(await claimed.json()).toEqual({ status: "claimed" });

    const unauthorized = await SELF.fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ action: "status", ownerSecret: "wrong" }),
    });
    expect(await unauthorized.json()).toEqual({ status: "unauthorized" });
  });

  it("opens a private Android download page from a four-digit code", async () => {
    const { response, body } = await createDownloadPair();
    expect(response.status).toBe(201);

    const page = await SELF.fetch(`https://pair.test/${body.code}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Download file");
  });

  it("rejects public, credentialed, wrong-port, and tokenless redirect targets", async () => {
    const invalid = [
      "https://192.168.1.25:8081/upload?t=x",
      "http://example.com:8081/upload?t=x",
      "http://user:pass@192.168.1.25:8081/upload?t=x",
      "http://192.168.1.25:9000/upload?t=x",
      "http://192.168.1.25:8081/upload",
      "http://192.168.1.25:8081/other?t=x",
    ];
    for (const uploadUrl of invalid) {
      const { response } = await createPair(uploadUrl);
      expect(response.status, uploadUrl).toBe(400);
    }
  });

  it("supports private 10/8, 172.16/12, and 192.168/16 LANs", async () => {
    for (const host of ["10.0.0.4", "172.16.4.9", "172.31.255.2", "192.168.49.1"]) {
      const { response } = await createPair(`http://${host}:8081/upload?t=x`);
      expect(response.status, host).toBe(201);
    }
  });

  it("serves a no-install PC entry page with security headers", async () => {
    const response = await SELF.fetch("https://pair.test/");
    expect(response.status).toBe(200);
    const homePage = await response.text();
    expect(homePage).toContain("Enter the 4-digit code");
    expect(homePage).toContain("--blue:#2979FF");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not silently block invalid form input", async () => {
    const home = await SELF.fetch("https://pair.test/");
    expect(await home.text()).toContain("novalidate");

    const invalid = await SELF.fetch("https://pair.test/?code=12x4");
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("Invalid code");
  });
});
