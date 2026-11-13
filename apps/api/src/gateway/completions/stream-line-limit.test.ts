import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../../app";
import prisma from "../../shared/db/client";
import { authedAgent } from "../../test-utils";
import {
  allowLoopbackForTests,
  resetSsrfAllowlist,
} from "../../tools/execute/safe-fetch";
import { MAX_SSE_LINE_CHARS } from "../providers/sse-parse";

const app = createApp();

/** What the fake upstream does after the headers: see each test. */
let mode: "frame-then-endless-line" | "endless-line" = "frame-then-endless-line";
let server: http.Server;
let origin: string;

/** Writes `total` newline-free bytes in 64 KiB writes, honouring backpressure. */
function writeLineWithoutEnd(res: http.ServerResponse, total: number): void {
  const piece = "a".repeat(64 * 1024);
  let sent = 0;
  const pump = (): void => {
    while (sent < total && !res.destroyed) {
      sent += piece.length;
      if (!res.write(piece)) {
        res.once("drain", pump);
        return;
      }
    }
    res.end();
  };
  pump();
}

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (mode === "frame-then-endless-line") {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] })}\n\n`,
        );
      }
      // Past the line limit, with no newline anywhere: a team's own base_url can do this.
      writeLineWithoutEnd(res, MAX_SSE_LINE_CHARS + 4 * 1024 * 1024);
    });
  });
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetSsrfAllowlist();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** Signs up a team with an openai_compatible connection on the fake upstream and a model `m`. */
async function arrange() {
  const { agent, teamId } = await authedAgent(app);
  const conn = await agent
    .post("/api/v1/gateway/connections")
    .send({
      provider: "openai_compatible",
      label: "endless",
      apiKey: "sk-test-00000000000AB12",
      config: { base_url: `${origin}/v1` },
    })
    .expect(201);
  await agent
    .post("/api/v1/gateway/models")
    .send({
      publicName: "m",
      upstreamModel: "endless-1",
      credentialId: conn.body.id,
      inputPricePerM: 1,
      outputPricePerM: 1,
    })
    .expect(201);
  return { agent, teamId };
}

const ASK = {
  model: "m",
  stream: true,
  messages: [{ role: "user", content: "Say hello." }],
};

describe("a streamed answer whose line never ends", () => {
  it("ends the stream with an error frame once the line passes the limit", async () => {
    mode = "frame-then-endless-line";
    const { agent, teamId } = await arrange();

    const res = await agent
      .post("/api/v1/gateway/chat/completions")
      .set("x-gateway-cache", "no-store")
      .send(ASK)
      .expect(200);

    const frames = (res.text as string)
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice(6));
    expect(JSON.parse(frames[0]!).choices[0].delta.content).toBe("Hello");
    const error = frames.map((f) => (f === "[DONE]" ? null : JSON.parse(f))).find((f) => f?.error);
    expect(error.error.code).toBe("PROVIDER_ERROR");
    expect(error.error.message).toMatch(/exceeds the \d+ character limit/);

    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
  }, 30_000);

  it("answers 409 before any byte is streamed when the first line never ends", async () => {
    mode = "endless-line";
    const { agent, teamId } = await arrange();

    const res = await agent
      .post("/api/v1/gateway/chat/completions")
      .set("x-gateway-cache", "no-store")
      .send(ASK)
      .expect(409);

    // The same answer as a buffered response past its byte cap: retrying cannot help.
    expect(res.body.error.code).toBe("PROVIDER_REJECTED");
    expect(res.body.error.message).toMatch(/exceeds the \d+ character limit/);
    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
  }, 30_000);
});
