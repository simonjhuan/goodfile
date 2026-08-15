import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

test("redirects the short root to the pairing service", async () => {
  const response = await worker.fetch(new Request("https://gf.example/"));

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://goodfile-pair.maew0009.workers.dev/");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("preserves path and query parameters", async () => {
  const response = await worker.fetch(new Request("https://gf.example/1234?source=android"));

  assert.equal(response.headers.get("location"), "https://goodfile-pair.maew0009.workers.dev/1234?source=android");
});

test("rejects methods other than GET and HEAD", async () => {
  const response = await worker.fetch(new Request("https://gf.example/", { method: "POST" }));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});
