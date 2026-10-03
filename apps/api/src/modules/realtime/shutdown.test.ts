import { expect, it } from "vitest";
import { ServerEvent } from "@quiz/contracts";
import { testServer } from "../../test/http.js";

it("sends a typed update frame and ends SSE before shutdown waits for responses", async () => {
  const server = await testServer();
  try {
    const user = await server.signIn("student");
    const response = await server.app.inject({
      method: "GET", url: "/app/api/events", headers: user.headers, payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    const stream = response.stream();
    let text = "";
    stream.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    const ended = new Promise<void>((resolve) => stream.on("end", resolve));
    await server.app.close();
    await ended;
    expect(text).toContain("event: platform.updating\n");
    const frame = text.split("\n").find((line) => line.includes('"platform.updating"'))!;
    expect(ServerEvent.parse(JSON.parse(frame.slice("data: ".length)))).toEqual({ type: "platform.updating" });
  } finally {
    await server.close();
  }
});
