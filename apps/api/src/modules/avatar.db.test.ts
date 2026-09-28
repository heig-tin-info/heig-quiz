/**
 * The uploaded avatar: its type is read from the bytes, and it is served so
 * that a browser can never treat it as a document.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { testServer, type TestServer } from "../test/http.js";

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let student: Caller;

/** The smallest header `sniffImage` reads as a PNG. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]),
]);

function put(body: Buffer, contentType: string) {
  return server.app.inject({
    method: "PUT",
    url: "/app/api/me/avatar",
    headers: { ...student.headers, "content-type": contentType },
    payload: body,
  });
}

beforeAll(async () => {
  server = await testServer();
  student = await server.signIn("student");
});

afterAll(async () => {
  await server.close();
});

describe("avatar", () => {
  it("refuses bytes that are not the image type they claim to be", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect((await put(html, "image/png")).statusCode).toBe(415);
    // A real PNG declared as JPEG is refused as well: the header must match.
    expect((await put(PNG, "image/jpeg")).statusCode).toBe(415);
  });

  it("stores a real image and serves it with nosniff and a sandboxing CSP", async () => {
    expect((await put(PNG, "image/png")).statusCode).toBe(204);
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/users/${student.id}/avatar`,
      headers: student.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  });
});
