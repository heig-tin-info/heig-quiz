/**
 * The uploaded avatar: its type is read from the bytes, it is served so that
 * a browser can never treat it as a document, and only to someone who
 * already sees its owner somewhere in the application (#318).
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { enrollments, users } from "../db/schema.js";
import { REMOTE_IMAGE_MAX_BYTES } from "../remoteImage.js";
import { testServer, type TestServer } from "../test/http.js";
import { addStaff, createClassroom, createCourse } from "./org/service.js";
import { createPool } from "./pool/service.js";

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let student: Caller;

/** The smallest header `sniffImage` reads as a PNG. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]),
]);

function put(body: Buffer, contentType: string, as: Caller = student) {
  return server.app.inject({
    method: "PUT",
    url: "/app/api/me/avatar",
    headers: { ...as.headers, "content-type": contentType },
    payload: body,
  });
}

async function fetchAvatar(of: Caller, as: Caller) {
  return (
    await server.app.inject({
      method: "GET",
      url: `/app/api/users/${of.id}/avatar`,
      headers: as.headers,
    })
  ).statusCode;
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

  describe("audience (#318)", () => {
    // `teacher` and `colleague` share the staff of PRG1, where `student` sits
    // a classroom; `outsider` teaches another course; `stranger` and
    // `classmate` are students, the latter in the same classroom.
    let teacher: Caller;
    let colleague: Caller;
    let outsider: Caller;
    let stranger: Caller;
    let classmate: Caller;
    let admin: Caller;
    let bare: Caller;

    beforeAll(async () => {
      const db = server.app.db;
      [teacher, colleague, outsider, stranger, classmate, admin, bare] = await Promise.all([
        server.signIn("teacher"),
        server.signIn("teacher"),
        server.signIn("teacher"),
        server.signIn("student"),
        server.signIn("student"),
        server.signIn("admin"),
        server.signIn("teacher"),
      ]);
      const course = (await createCourse(db, { name: "Prog 1", code: "PRG1" }, teacher.id))!;
      await addStaff(db, course.id, colleague.id, "assistant");
      await createCourse(db, { name: "Other", code: "OTH1" }, outsider.id);
      const room = await createClassroom(db, course.id, { name: "PRG1-A", period: "2026" });
      await db.insert(enrollments).values(
        [student, classmate].map((s, i) => ({
          id: randomUUID(),
          classroomId: room.id,
          nom: `N${i}`,
          prenom: `P${i}`,
          email: `s${i}@heig.test`,
          userId: s.id,
        })),
      );
      for (const who of [student, teacher, colleague]) {
        expect((await put(PNG, "image/png", who)).statusCode).toBe(204);
      }
    });

    it("serves a picture to its owner and to an admin, by role, without Super Powers (ADR-054)", async () => {
      expect(await fetchAvatar(teacher, teacher)).toBe(200);
      expect(await fetchAvatar(student, admin)).toBe(200);
      expect(await fetchAvatar(teacher, admin)).toBe(200);
    });

    it("serves a staff member's picture to a fellow member of that staff", async () => {
      expect(await fetchAvatar(teacher, colleague)).toBe(200);
      expect(await fetchAvatar(colleague, teacher)).toBe(200);
    });

    it("serves a student's picture to the staff of a course where they sit a classroom", async () => {
      expect(await fetchAvatar(student, teacher)).toBe(200);
      expect(await fetchAvatar(student, colleague)).toBe(200);
    });

    it("answers anyone else the 404 of a missing picture", async () => {
      for (const who of [outsider, stranger, classmate]) {
        expect(await fetchAvatar(student, who)).toBe(404);
        expect(await fetchAvatar(teacher, who)).toBe(404);
      }
      // A student never sees their teacher's face: no screen shows it to them.
      expect(await fetchAvatar(teacher, student)).toBe(404);
    });

    it("serves a pool owner's picture to the teachers who list that pool, and only to them", async () => {
      // The pool list shows every pool's owner as an avatar (ADR-013,
      // amendment of 2026-10-04): a public pool's owner is seen by every
      // teacher, a private one's by nobody new — and never by a student.
      const db = server.app.db;
      const [publisher, hermit] = await Promise.all([
        server.signIn("teacher"),
        server.signIn("teacher"),
      ]);
      for (const who of [publisher, hermit]) {
        expect((await put(PNG, "image/png", who)).statusCode).toBe(204);
      }
      await createPool(db, { name: "Open", isPublic: true, ownerId: publisher.id });
      await createPool(db, { name: "Closed", ownerId: hermit.id });
      expect(await fetchAvatar(publisher, outsider)).toBe(200);
      expect(await fetchAvatar(hermit, outsider)).toBe(404);
      expect(await fetchAvatar(publisher, stranger)).toBe(404);
    });

    it("still answers 404 for someone with no picture, whoever asks", async () => {
      expect(await fetchAvatar(bare, bare)).toBe(404);
      expect(await fetchAvatar(bare, admin)).toBe(404);
    });
  });

  describe("the IdP's picture, served from here (audit 2026-10-10, §6)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** A user whose IdP claim is `url`, with no upload. */
    async function withPicture(url: string, answer: () => Response) {
      const owner = await server.signIn("teacher");
      await server.app.db.update(users).set({ pictureUrl: url }).where(eq(users.id, owner.id));
      const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
      const me = (await server.app.inject({ method: "GET", url: "/app/api/me", headers: owner.headers })).json();
      /** The owner's picture as `who` reads it. */
      const read = (who: Caller = owner) =>
        server.app.inject({ method: "GET", url: `/app/api/users/${owner.id}/avatar`, headers: who.headers });
      return { me, read, fetched };
    }

    it("is a same-origin address, serves the bytes inert, and is fetched once", async () => {
      const { me, read, fetched } = await withPicture("https://idp.example/p/1.png", () => new Response(PNG));
      expect(me.avatarUrl).toMatch(new RegExp(`^/app/api/users/${me.id}/avatar\\?v=[0-9a-f]{12}$`));
      const res = await read();
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect((await read()).statusCode).toBe(200);
      expect(fetched).toHaveBeenCalledOnce();
    });

    it("answers someone who does not see its owner the 404 of no picture, and fetches nothing (#318)", async () => {
      const { read, fetched } = await withPicture("https://idp.example/p/2.png", () => new Response(PNG));
      const stranger = await server.signIn("student");
      expect((await read(stranger)).statusCode).toBe(404);
      expect(fetched).not.toHaveBeenCalled();
    });

    it("refuses what is not an image by its bytes, whatever its declared type", async () => {
      const html = () => new Response("<html><script>alert(1)</script></html>", { headers: { "content-type": "image/png" } });
      expect((await (await withPicture("https://idp.example/p/3.png", html)).read()).statusCode).toBe(404);
    });

    it("refuses a body over the cap", async () => {
      const big = () => new Response(Buffer.concat([PNG, Buffer.alloc(REMOTE_IMAGE_MAX_BYTES)]));
      expect((await (await withPicture("https://idp.example/p/4.png", big)).read()).statusCode).toBe(404);
    });

    it("never fetches an address that is not https to a public name", async () => {
      for (const url of [
        "http://idp.example/p/5.png",
        "https://127.0.0.1/p.png",
        "https://[::1]/p.png",
        "https://10.0.0.7/p.png",
        "https://localhost/p.png",
        "https://intranet/p.png",
        "https://db.internal/p.png",
      ]) {
        const { me, read, fetched } = await withPicture(url, () => new Response(PNG));
        expect((await read()).statusCode, url).toBe(404);
        expect(fetched, url).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        if (url.startsWith("http:")) expect(me.avatarUrl).toBeNull();
      }
    });
  });
});
