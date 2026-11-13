import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createApp } from "../../../app";
import prisma from "../../shared/db/client";
import { authedAgent } from "../../test-utils";
import {
  allowLoopbackForTests,
  resetSsrfAllowlist,
} from "../../tools/execute/safe-fetch";
import { __resetRateLimiter } from "./rate-limiter";

/**
 * A budget must bound the call it admits, without cutting answers short for a team
 * that has plenty left. A call that sends no `max_tokens` is capped only when the
 * money left in the budget cannot pay for a long answer: then it is held to what the
 * remaining money buys, so one call cannot spend several times the cap.
 */

const app = createApp();

/** Completion tokens the fake upstream produces when the request carries no output cap. */
const UNCAPPED_COMPLETION_TOKENS = 4000;

/** Every request body the fake upstream received, newest last. */
let received: Array<Record<string, unknown>> = [];
let server: http.Server;
let origin: string;
/** Calls the fake upstream is holding open, and how to answer each. */
const held = new Set<http.ServerResponse>();
let heldReleases: Array<() => void> = [];

/** Polls until the fake upstream holds `n` calls open. */
async function untilHeld(n: number): Promise<void> {
  for (let i = 0; i < 200 && heldReleases.length < n; i++) await new Promise((r) => setTimeout(r, 25));
  if (heldReleases.length < n) throw new Error(`only ${heldReleases.length} of ${n} calls reached the upstream`);
}

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }
      received.push(body);
      // A model named "down" is an outage, so the chain falls back past it.
      if (body.model === "down") {
        res.writeHead(500, { "Content-Type": "application/json" }).end('{"error":{"message":"down"}}');
        return;
      }
      // A prompt that says HOLD stays open until the test releases it, so the test can
      // look at what the call reserved while it is in flight.
      const messages = body.messages as Array<{ content: string }> | undefined;
      if (messages?.some((m) => m.content === "HOLD") && !held.has(res)) {
        held.add(res);
        heldReleases.push(() => {
          if (res.headersSent) return;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "gen-held",
              model: body.model,
              choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            }),
          );
        });
        return;
      }
      // Behaves like a real model: it writes until it hits the cap it was given, and
      // runs long when it was given none.
      const cap = (body.max_tokens ?? body.max_completion_tokens) as number | undefined;
      const completion = cap ?? UNCAPPED_COMPLETION_TOKENS;
      const usage = { prompt_tokens: 10, completion_tokens: completion, total_tokens: 10 + completion };
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "word word" }, finish_reason: cap ? "length" : "stop" }] })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
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
              message: { role: "assistant", content: "word word" },
              finish_reason: cap ? "length" : "stop",
            },
          ],
          usage,
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

afterEach(() => {
  // A failed assertion must not leave a call open, or the run never exits.
  for (const release of heldReleases) release();
  heldReleases = [];
});

beforeEach(() => {
  received = [];
  heldReleases = [];
  __resetRateLimiter();
});

/**
 * Signs up a team with a `provider` connection on the fake upstream, a model `m` at
 * $10 per million tokens each way, and a virtual key.
 */
async function arrange(provider: "openai_compatible" | "openai" = "openai_compatible") {
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
      inputPricePerM: 10,
      outputPricePerM: 10,
    })
    .expect(201);
  const key = await agent.post("/api/v1/gateway/keys").send({ name: "app" }).expect(201);
  return { agent, keyId: key.body.id as string, key: key.body.key as string };
}

/** No `max_tokens` and no `max_completion_tokens`. */
const ASK = {
  model: "m",
  messages: [{ role: "user", content: "Write a long story." }],
};

// At $10/M this buys about 2000 output tokens: an uncapped 4000-token answer ($0.04)
// would spend twice the cap, so a call under it must be capped.
const LIMIT_USD = 0.02;

/** Output tokens $LIMIT_USD buys at $10/M, before the prompt's share. */
const AFFORDABLE_TOKENS = 2000;

describe("a budget bounds a call that omits max_tokens", () => {
  it.each([false, true])("stream=%s: the upstream call is capped and spend stays under the limit", async (stream) => {
    const { agent, keyId, key } = await arrange();
    const budget = await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: keyId, period: "total", limitUsd: LIMIT_USD })
      .expect(201);

    await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .set("x-gateway-cache", "no-store")
      .send({ ...ASK, stream })
      .expect(200);

    const row = await prisma.budget.findUniqueOrThrow({ where: { id: budget.body.id } });
    expect(row.spendUsd.toNumber()).toBeLessThanOrEqual(LIMIT_USD);
    expect(received).toHaveLength(1);
    // Held to what the remaining money buys: $0.02 less a 5% margin and the prompt.
    const cap = received[0]!["max_tokens"] as number;
    expect(cap).toBeGreaterThan(AFFORDABLE_TOKENS * 0.9);
    expect(cap).toBeLessThan(AFFORDABLE_TOKENS);
  });

  it.each([false, true])("stream=%s: a budget with plenty left sends the call uncapped", async (stream) => {
    const { agent, keyId, key } = await arrange();
    await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: keyId, period: "month", limitUsd: 1000 })
      .expect(201);

    const res = await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .set("x-gateway-cache", "no-store")
      .send({ ...ASK, stream })
      .expect(200);

    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty("max_tokens");
    expect(received[0]).not.toHaveProperty("max_completion_tokens");
    if (!stream) expect(res.body.usage.completion_tokens).toBe(UNCAPPED_COMPLETION_TOKENS);
  });

  it("caps at 4096 when the money left buys more than that but not a long answer", async () => {
    const { agent, keyId, key } = await arrange();
    // $0.20 at $10/M buys about 20,000 tokens: under the 32,000 a long answer may need.
    await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: keyId, period: "total", limitUsd: 0.2 })
      .expect(201);

    await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .set("x-gateway-cache", "no-store")
      .send(ASK)
      .expect(200);

    expect(received[0]!["max_tokens"]).toBe(4096);
  });

  it("uses the tighter of a team-wide and a key budget", async () => {
    const { agent, keyId, key } = await arrange();
    await agent.post("/api/v1/gateway/budgets").send({ period: "month", limitUsd: 1000 }).expect(201);
    await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: keyId, period: "total", limitUsd: LIMIT_USD })
      .expect(201);

    await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .set("x-gateway-cache", "no-store")
      .send(ASK)
      .expect(200);

    expect(received[0]!["max_tokens"]).toBeLessThan(AFFORDABLE_TOKENS);
  });

  it("sends the cap to native OpenAI under its own name", async () => {
    const { agent, keyId, key } = await arrange("openai");
    await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: keyId, period: "total", limitUsd: LIMIT_USD })
      .expect(201);

    await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .set("x-gateway-cache", "no-store")
      .send(ASK)
      .expect(200);

    expect(received[0]!["max_completion_tokens"]).toBeLessThan(AFFORDABLE_TOKENS);
    expect(received[0]).not.toHaveProperty("max_tokens");
  });

  it("leaves a caller's own max_tokens alone", async () => {
    const { agent, keyId, key } = await arrange();
    await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: keyId, period: "total", limitUsd: 1 })
      .expect(201);

    await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .send({ ...ASK, max_tokens: 3000 })
      .expect(200);

    expect(received[0]!["max_tokens"]).toBe(3000);
  });

  it.each([false, true])("stream=%s: a call with no budget is sent upstream with no cap", async (stream) => {
    const { key } = await arrange();

    await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .set("x-gateway-cache", "no-store")
      .send({ ...ASK, stream })
      .expect(200);

    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty("max_tokens");
    expect(received[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("does not serve a capped cached answer to a later call that has no budget", async () => {
    const { agent } = await arrange();
    const cached = await agent
      .post("/api/v1/gateway/keys")
      .send({ name: "cached", cacheTtlSeconds: 300 })
      .expect(201);
    const budget = await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: cached.body.id, period: "total", limitUsd: LIMIT_USD })
      .expect(201);
    const deterministic = { ...ASK, temperature: 0 };

    await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${cached.body.key}`)
      .send(deterministic)
      .expect(200);
    await agent.delete(`/api/v1/gateway/budgets/${budget.body.id}`).expect(204);
    const second = await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${cached.body.key}`)
      .send(deterministic)
      .expect(200);

    // The first answer was cut at the budget's cap; the uncapped call goes upstream.
    expect(received).toHaveLength(2);
    expect(received[1]).not.toHaveProperty("max_tokens");
    expect(second.body.usage.completion_tokens).toBe(UNCAPPED_COMPLETION_TOKENS);
  });

  it("an uncapped call reserves what a long answer costs, so parallel calls cannot overshoot", async () => {
    const { agent, keyId, key } = await arrange();
    // $1 at $10/M buys 100,000 output tokens: plenty, so the call goes out uncapped.
    const budget = await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: keyId, period: "total", limitUsd: 1 })
      .expect(201);

    const inFlight = request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key}`)
      .set("x-gateway-cache", "no-store")
      .send({ model: "m", messages: [{ role: "user", content: "HOLD" }] })
      .then((r) => r);
    await untilHeld(1);

    const row = await prisma.budget.findUniqueOrThrow({ where: { id: budget.body.id } });
    // 32,000 output tokens at $10/M are held while the answer is unknown.
    expect(row.spendUsd.toNumber()).toBeGreaterThanOrEqual(0.32);
    heldReleases[0]!();
    expect((await inFlight).status).toBe(200);
  });

  it("caps a call that the money left after another call's hold can no longer pay in full", async () => {
    const { agent, keyId, key } = await arrange();
    await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: keyId, period: "total", limitUsd: 0.5 })
      .expect(201);
    const send = (content: string) =>
      request(app)
        .post("/api/v1/gateway/chat/completions")
        .set("Authorization", `Bearer ${key}`)
        .set("x-gateway-cache", "no-store")
        .send({ model: "m", messages: [{ role: "user", content }] })
        .then((r) => r);

    const first = send("HOLD");
    await untilHeld(1);
    const second = await send("Write a long story.");

    expect(second.status).toBe(200);
    // The first call holds $0.32 of the $0.50, so the second is held to what is left.
    const secondBody = received[received.length - 1]!;
    expect(secondBody["max_tokens"]).toBeDefined();
    expect(secondBody["max_tokens"] as number).toBeLessThanOrEqual(4096);
    heldReleases[0]!();
    expect((await first).status).toBe(200);
  });

  it("prices the cap at the dearest model the call can fall back to", async () => {
    const { agent } = await authedAgent(app);
    const conn = await agent
      .post("/api/v1/gateway/connections")
      .send({
        provider: "openai_compatible",
        label: "fake",
        apiKey: "sk-test-00000000000AB12",
        config: { base_url: `${origin}/v1` },
      })
      .expect(201);
    // The fallback costs 125x the primary.
    const dear = await agent
      .post("/api/v1/gateway/models")
      .send({ publicName: "dear", upstreamModel: "dear", credentialId: conn.body.id, inputPricePerM: 15, outputPricePerM: 75 })
      .expect(201);
    await agent
      .post("/api/v1/gateway/models")
      .send({
        publicName: "m",
        upstreamModel: "down",
        credentialId: conn.body.id,
        inputPricePerM: 0.15,
        outputPricePerM: 0.6,
        fallbackModelIds: [dear.body.id],
      })
      .expect(201);
    const key = await agent.post("/api/v1/gateway/keys").send({ name: "app" }).expect(201);
    await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: key.body.id, period: "total", limitUsd: LIMIT_USD })
      .expect(201);

    await request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key.body.key}`)
      .set("x-gateway-cache", "no-store")
      .send(ASK)
      .expect(200);

    const servedBy = received.find((b) => b.model === "dear")!;
    // $0.02 at $75/M buys about 266 output tokens; at the primary's price it would be 33,000.
    expect(servedBy["max_tokens"] as number).toBeLessThanOrEqual(266);
  });

  it("still serves a cached answer once the budget nears its limit", async () => {
    const { agent } = await arrange();
    const cached = await agent
      .post("/api/v1/gateway/keys")
      .send({ name: "cached", cacheTtlSeconds: 300 })
      .expect(201);
    const budget = await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: cached.body.id, period: "total", limitUsd: 1000 })
      .expect(201);
    const deterministic = { ...ASK, temperature: 0 };
    const send = () =>
      request(app)
        .post("/api/v1/gateway/chat/completions")
        .set("Authorization", `Bearer ${cached.body.key}`)
        .send(deterministic)
        .expect(200);

    await send();
    // Leave a cent: a live call would now be capped.
    await prisma.budget.update({ where: { id: budget.body.id }, data: { spendUsd: 999.99 } });
    const second = await send();

    expect(received).toHaveLength(1);
    expect(second.body.usage.completion_tokens).toBe(UNCAPPED_COMPLETION_TOKENS);
  });
});
