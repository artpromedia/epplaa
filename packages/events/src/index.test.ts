import { describe, it, expect, beforeEach } from "vitest";
import {
  registerConsumer,
  getRegisteredConsumers,
  __resetRegistryForTests,
  envelopeMetaSchema,
} from "./index.js";

describe("@workspace/events registry", () => {
  beforeEach(() => __resetRegistryForTests());

  it("registers and retrieves consumers per topic", () => {
    const handler = async () => {};
    registerConsumer("order.placed", handler);
    expect(getRegisteredConsumers("order.placed")).toHaveLength(1);
    expect(getRegisteredConsumers("nope")).toHaveLength(0);
  });

  it("supports multiple consumers per topic (fan-out)", () => {
    registerConsumer("order.placed", async () => {});
    registerConsumer("order.placed", async () => {});
    expect(getRegisteredConsumers("order.placed")).toHaveLength(2);
  });
});

describe("envelope schema", () => {
  it("validates a well-formed envelope", () => {
    const ok = envelopeMetaSchema.safeParse({
      eventId: "11111111-1111-1111-1111-111111111111",
      topic: "order.placed",
      aggregateId: "ord_123",
      eventType: "OrderPlaced",
      occurredAt: "2026-05-01T00:00:00.000Z",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects empty fields", () => {
    const bad = envelopeMetaSchema.safeParse({
      eventId: "",
      topic: "x",
      aggregateId: "x",
      eventType: "x",
      occurredAt: "2026-05-01T00:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });
});
