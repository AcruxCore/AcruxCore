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
 * A reservation taken in one budget period must not be credited back against the
 * next one. The period reset zeroes spend_usd, reservations included, so a call still
 * in flight at the boundary must settle against the new period with its real cost
 * only; crediting back its unused estimate there would push spend below zero and
 * hand the new period extra headroom.
 */

const app = createApp();

/** The `max_tokens` value the fake upstream holds open until the test releases it. */
const HELD_MAX_TOKENS = 4900;

let received: Array<Record<string, unknown>> = [];
let releaseHeld: (() => void) | null = null;
let server: http.Server;
let origin: string;

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
      const answer = () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "gen-1",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
          }),
        );
      };
      if (body.max_tokens === HELD_MAX_TOKENS) {
        releaseHeld = answer;
        return;
      }
      answer();
    });
  });
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
  releaseHeld = null;
  __resetRateLimiter();
});

/** Polls until the fake upstream is holding a request open. */
async function untilHeld(): Promise<void> {
  for (let i = 0; i < 200 && !releaseHeld; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!releaseHeld) throw new Error("the held request never reached the upstream");
}

const LIMIT_USD = 0.05;

/** A call whose reservation is about `maxTokens` x $10/M. */
function ask(maxTokens: number) {
  return { model: "m", messages: [{ role: "user", content: "Say hi." }], max_tokens: maxTokens };
}

/** Sets up a key with a $LIMIT_USD day budget on model "m"; returns the caller and budget id. */
async function keyWithDayBudget() {
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
  await agent
    .post("/api/v1/gateway/models")
    .send({ publicName: "m", upstreamModel: "m", credentialId: conn.body.id, inputPricePerM: 10, outputPricePerM: 10 })
    .expect(201);
  const key = await agent.post("/api/v1/gateway/keys").send({ name: "app" }).expect(201);
  const budget = await agent
    .post("/api/v1/gateway/budgets")
    .send({ virtualKeyId: key.body.id, period: "day", limitUsd: LIMIT_USD })
    .expect(201);
  const call = (body: object) =>
    request(app)
      .post("/api/v1/gateway/chat/completions")
      .set("Authorization", `Bearer ${key.body.key}`)
      .set("x-gateway-cache", "no-store")
      .send(body);
  return { agent, budgetId: budget.body.id as string, call };
}

describe("budget period change with a call in flight", () => {
  it("credits the unused reservation back when an admin changes the period mid-call", async () => {
    const { agent, budgetId, call } = await keyWithDayBudget();

    // A ~$0.049 reservation is taken and held open upstream.
    const inFlight = call(ask(HELD_MAX_TOKENS)).then((r) => r);
    await untilHeld();

    // The owner switches the budget from a day to a week. That moves resets_at but does
    // not zero spend, so the row still holds the reservation.
    await agent.patch(`/api/v1/gateway/budgets/${budgetId}`).send({ period: "week" }).expect(200);

    releaseHeld!();
    expect((await inFlight).status).toBe(200);

    const row = await prisma.budget.findUniqueOrThrow({ where: { id: budgetId } });
    // Only the call's real cost (15 tokens x $10/M) stays booked.
    expect(row.spendUsd.toNumber()).toBeCloseTo(0.00015, 9);
  });
});

describe("budget period rollover with a call in flight", () => {
  it("settles the old period's reservation without crediting the new period", async () => {
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
    await agent
      .post("/api/v1/gateway/models")
      .send({ publicName: "m", upstreamModel: "m", credentialId: conn.body.id, inputPricePerM: 10, outputPricePerM: 10 })
      .expect(201);
    const key = await agent.post("/api/v1/gateway/keys").send({ name: "app" }).expect(201);
    const budget = await agent
      .post("/api/v1/gateway/budgets")
      .send({ virtualKeyId: key.body.id, period: "day", limitUsd: LIMIT_USD })
      .expect(201);
    const call = (body: object) =>
      request(app)
        .post("/api/v1/gateway/chat/completions")
        .set("Authorization", `Bearer ${key.body.key}`)
        .set("x-gateway-cache", "no-store")
        .send(body);

    // A ~$0.09 reservation never fits a $0.05 day.
    await call(ask(9000)).expect(402);

    // Period P ends two seconds from now (rather than at the next UTC midnight, which
    // a test cannot wait for). The clock then really crosses it while a call is held.
    const periodEnd = Date.now() + 2000;
    await prisma.budget.update({ where: { id: budget.body.id }, data: { resetsAt: new Date(periodEnd) } });

    // Period P: a ~$0.049 reservation is taken and held open upstream.
    const inFlight = call(ask(HELD_MAX_TOKENS)).then((r) => r);
    await untilHeld();

    // The boundary passes; the next call performs the lazy reset into period P+1.
    await new Promise((r) => setTimeout(r, Math.max(0, periodEnd - Date.now() + 50)));
    await call(ask(10)).expect(200);

    // The held call now finishes and settles.
    releaseHeld!();
    expect((await inFlight).status).toBe(200);

    const row = await prisma.budget.findUniqueOrThrow({ where: { id: budget.body.id } });
    expect(row.resetsAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.spendUsd.toNumber()).toBeGreaterThanOrEqual(0);
    // P+1 carries both calls' real cost (15 tokens x $10/M each) and nothing else.
    expect(row.spendUsd.toNumber()).toBeCloseTo(2 * 0.00015, 9);
    // Period P+1 still refuses what no period can afford.
    await call(ask(9000)).expect(402);
  });
});
