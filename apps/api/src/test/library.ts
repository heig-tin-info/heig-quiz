/**
 * Documents of a course's library for the route tests (ADR-144): uploaded
 * through the real route, as the staff's browser sends them, and renamed so
 * that their title (what students read) is not their file name (the staff's
 * alone). Test support only; nothing in the application imports it.
 */
import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import { CourseDocument } from "@quiz/contracts";

import type { Actor, TestServer } from "./http.js";

/** A distinct small PDF. */
export const pdfBytes = (marker = randomUUID()) => Buffer.from(`%PDF-1.7\n%${marker}\n%%EOF\n`, "latin1");

/** A multipart body of one file, as a browser's `FormData` sends it. */
function multipart(bytes: Buffer, filename: string) {
  const boundary = `----library${randomUUID()}`;
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** Uploads `bytes` as `filename` into the course's library, then gives it `title`: the stored document. */
export async function uploadDocument(
  server: TestServer,
  courseId: string,
  by: Actor,
  file: { bytes: Buffer; filename: string; title: string },
): Promise<CourseDocument> {
  const form = multipart(file.bytes, file.filename);
  const res = await server.app.inject({
    method: "POST",
    url: `/app/api/courses/${courseId}/documents`,
    headers: { ...by.headers, ...form.headers },
    payload: form.payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  const { id } = CourseDocument.parse(res.json());
  const renamed = await server.app.inject({
    method: "PATCH",
    url: `/app/api/courses/${courseId}/documents/${id}`,
    headers: by.headers,
    payload: { title: file.title },
  });
  expect(renamed.statusCode, renamed.body).toBe(200);
  return CourseDocument.parse(renamed.json());
}
