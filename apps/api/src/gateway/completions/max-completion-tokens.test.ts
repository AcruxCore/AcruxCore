import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../../app";
import prisma from "../../shared/db/client";
import { authedAgent } from "../../test-utils";
import {
  allowLoopbackForTests,
  resetSsrfAllowlist,
} from "../../tools/execute/safe-fetch";

const app = createApp();

/** Every request body the fake upstream received, newest last. */
let received: Array<Record<string, unknown>> = [];
let server: http.Server;
let origin: string;

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      // A non-JSON request would throw inside this listener and kill the whole Jest run,
      // so it gets a 400 and fails only the test that sent it.
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }
      received.push(body);
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "1 2" }, finish_reason: "length" }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 } })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-1",
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "1 2 3" },
              finish_reason: "length",
            },
          ],
          usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 },
        }),
      );
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

beforeEach(() => {
  received = [];
});

/** Signs up a team with one `provider` connection pointed at the fake upstream, and a `m` model on it. */
async function arrange(provider: "openai_compatible" | "openai") {
  const { agent } = await authedAgent(app);
  const conn = await agent
    .post("/api/v1/gateway/connections")
    .send({
      provider,
      label: provider,
      apiKey: "sk-test-00000000000AB12",
      config: { base_url: `${origin}/v1` },
    })
    .expect(201);
  await agent
    .post("/api/v1/gateway/models")
    .send({
      publicName: "m",
      upstreamModel: "gpt-6-luna",
      credentialId: conn.body.id,
      inputPricePerM: 1,
      outputPricePerM: 1,
    })
    .expect(201);
  return agent;
}

const ASK = {
  model: "m",
  messages: [{ role: "user", content: "Count from 1 to 50." }],
};

describe("max_completion_tokens through the gateway (issue #806)", () => {
  it("caps an openai_compatible call that sends max_completion_tokens, and does not list it as ignored", async () => {
    const agent = await arrange("openai_compatible");

    const res = await agent
      .post("/api/v1/gateway/chat/completions")
      .set("x-gateway-cache", "no-store")
      .send({ ...ASK, max_completion_tokens: 5 })
      .expect(200);

    expect(res.headers["x-gateway-params-ignored"]).toBeUndefined();
    expect(received).toHaveLength(1);
    // Third-party OpenAI-compatible servers take the legacy name.
    expect(received[0]!["max_tokens"]).toBe(5);
    expect(received[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("sends max_completion_tokens to native OpenAI when the caller used the new name", async () => {
    const agent = await arrange("openai");

    await agent
      .post("/api/v1/gateway/chat/completions")
      .set("x-gateway-cache", "no-store")
      .send({ ...ASK, max_completion_tokens: 5 })
      .expect(200);

    expect(received).toHaveLength(1);
    expect(received[0]!["max_completion_tokens"]).toBe(5);
    expect(received[0]).not.toHaveProperty("max_tokens");
  });

  it("caps a streamed call that sends max_completion_tokens", async () => {
    const agent = await arrange("openai_compatible");

    const res = await agent
      .post("/api/v1/gateway/chat/completions")
      .set("x-gateway-cache", "no-store")
      .send({ ...ASK, max_completion_tokens: 7, stream: true })
      .expect(200);

    expect(res.headers["x-gateway-params-ignored"]).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]!["max_tokens"]).toBe(7);
  });

  it("accepts both names when they agree", async () => {
    const agent = await arrange("openai_compatible");

    await agent
      .post("/api/v1/gateway/chat/completions")
      .set("x-gateway-cache", "no-store")
      .send({ ...ASK, max_tokens: 9, max_completion_tokens: 9 })
      .expect(200);

    expect(received[0]!["max_tokens"]).toBe(9);
  });

  it("rejects both names with different values, before any upstream call", async () => {
    const agent = await arrange("openai_compatible");

    const res = await agent
      .post("/api/v1/gateway/chat/completions")
      .send({ ...ASK, max_tokens: 9, max_completion_tokens: 5 })
      .expect(400);

    expect(JSON.stringify(res.body)).toMatch(/max_completion_tokens/);
    expect(received).toHaveLength(0);
  });

  it("reads max_completion_tokens: null as not set, as OpenAI's own schema does", async () => {
    const agent = await arrange("openai_compatible");

    const res = await agent
      .post("/api/v1/gateway/chat/completions")
      .set("x-gateway-cache", "no-store")
      .send({ ...ASK, max_completion_tokens: null })
      .expect(200);

    expect(res.headers["x-gateway-params-ignored"]).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]!["max_tokens"]).toBeUndefined();
    expect(received[0]!["max_completion_tokens"]).toBeUndefined();
  });

  it("rejects a non-positive max_completion_tokens", async () => {
    const agent = await arrange("openai_compatible");

    await agent
      .post("/api/v1/gateway/chat/completions")
      .send({ ...ASK, max_completion_tokens: 0 })
      .expect(400);

    expect(received).toHaveLength(0);
  });
});
