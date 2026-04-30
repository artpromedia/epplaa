import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Integration test for the Cloudflare Stream "video ready" webhook.
 *
 * Pins the contract that one CF webhook delivery for a given streamId
 * results in exactly one replay row, even on duplicate / racing
 * deliveries (Cloudflare retries until it sees a 200), and that the
 * stream row gets its `cf_video_uid` and `hls_url` populated from the
 * webhook payload.
 *
 * Skips itself if DATABASE_URL is not configured. Cleans up its own
 * rows so it does not pollute shared dev data.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;
const TEST_PREFIX = "test-cfwh-";
const WEBHOOK_SECRET = "test-cf-webhook-secret-" + crypto.randomBytes(8).toString("hex");

function rid(): string {
  return crypto.randomBytes(8).toString("hex");
}

function sign(body: Buffer, secret: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${body.toString("utf8")}`)
    .digest("hex");
  return `time=${ts},sig1=${sig}`;
}

d("CF Stream webhook — replay persistence", () => {
  type Db = typeof import("../lib/db")["db"];
  type Schema = typeof import("../lib/db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let app: Express;
  let priorWebhookSecret: string | undefined;

  async function cleanup(): Promise<void> {
    await db.execute(sql`DELETE FROM replays WHERE id LIKE ${TEST_PREFIX + "%"} OR live_stream_id LIKE ${TEST_PREFIX + "%"};`);
    await db.execute(sql`DELETE FROM streams WHERE id LIKE ${TEST_PREFIX + "%"};`);
  }

  beforeAll(async () => {
    if (!process.env.SESSION_SECRET) {
      // The import graph touches kyc.ts which requires SESSION_SECRET.
      process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
    }
    priorWebhookSecret = process.env.CF_STREAM_WEBHOOK_SECRET;
    process.env.CF_STREAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    ({ db, schema } = await import("../lib/db"));
    ({ sql } = await import("drizzle-orm"));
    const streamingWebhooksRouter = (await import("./streamingWebhooks")).default;

    // Mirror the production mount in app.ts — raw body parser BEFORE
    // the router so the HMAC verifier sees the unmodified bytes.
    app = express();
    app.use(
      "/api/streaming/webhooks",
      express.raw({ type: "*/*", limit: "1mb" }),
      streamingWebhooksRouter,
    );
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    if (priorWebhookSecret === undefined) {
      delete process.env.CF_STREAM_WEBHOOK_SECRET;
    } else {
      process.env.CF_STREAM_WEBHOOK_SECRET = priorWebhookSecret;
    }
  });

  async function seedStream(): Promise<string> {
    const streamId = `${TEST_PREFIX}str-${rid()}`;
    const cfInputId = `${TEST_PREFIX}input-${rid()}`;
    await db.insert(schema.streamsTable).values({
      id: streamId,
      hostName: "test-host",
      hostAvatar: "",
      title: "Test broadcast",
      posterImage: "",
      sellerUserId: `${TEST_PREFIX}user-${rid()}`,
      cfInputId,
      provider: "cloudflare",
      status: "ended",
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
      endedAt: new Date(),
    });
    return streamId;
  }

  function videoReadyPayload(streamId: string, opts: { videoUid?: string } = {}): Buffer {
    const videoUid = opts.videoUid ?? `vid-${rid()}`;
    return Buffer.from(
      JSON.stringify({
        uid: videoUid,
        status: { state: "ready" },
        duration: 615,
        thumbnail: `https://videodelivery.net/${videoUid}/thumbnails/thumbnail.jpg`,
        playback: { hls: `https://videodelivery.net/${videoUid}/manifest/video.m3u8` },
        meta: { name: "Test broadcast", streamId },
        created: new Date().toISOString(),
        liveInput: `live-input-${streamId}`,
      }),
      "utf8",
    );
  }

  it("rejects webhooks with a bad signature (200 with rejection body so CF doesn't disable the endpoint)", async () => {
    const streamId = await seedStream();
    const body = videoReadyPayload(streamId);
    const r = await request(app)
      .post("/api/streaming/webhooks/cloudflare")
      .set("Content-Type", "application/octet-stream")
      .set("Webhook-Signature", "time=1,sig1=deadbeef")
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, reason: "invalid_signature" });

    const replays = await db
      .select()
      .from(schema.replaysTable)
      .where(sql`${schema.replaysTable.liveStreamId} = ${streamId}`);
    expect(replays).toHaveLength(0);
  });

  it("persists exactly one replay row + stream cf_video_uid for a valid 'video ready' delivery", async () => {
    const streamId = await seedStream();
    const body = videoReadyPayload(streamId, { videoUid: "vid-canonical" });

    const r = await request(app)
      .post("/api/streaming/webhooks/cloudflare")
      .set("Content-Type", "application/octet-stream")
      .set("Webhook-Signature", sign(body, WEBHOOK_SECRET))
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, persisted: true });

    const replays = await db
      .select()
      .from(schema.replaysTable)
      .where(sql`${schema.replaysTable.liveStreamId} = ${streamId}`);
    expect(replays).toHaveLength(1);
    expect(replays[0]!.playbackUrl).toMatch(/manifest\/video\.m3u8/);
    expect(replays[0]!.durationSeconds).toBe(615);
    expect(replays[0]!.durationLabel).toBe("10:15");

    const [streamAfter] = await db
      .select()
      .from(schema.streamsTable)
      .where(sql`${schema.streamsTable.id} = ${streamId}`);
    expect(streamAfter.cfVideoUid).toBe("vid-canonical");
    expect(streamAfter.hlsUrl).toMatch(/manifest\/video\.m3u8/);
  });

  it("is idempotent under N parallel deliveries of the same webhook (CF retry storm)", async () => {
    const streamId = await seedStream();
    const body = videoReadyPayload(streamId, { videoUid: "vid-storm" });
    const sig = sign(body, WEBHOOK_SECRET);

    const N = 12;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post("/api/streaming/webhooks/cloudflare")
          .set("Content-Type", "application/octet-stream")
          .set("Webhook-Signature", sig)
          .send(body),
      ),
    );
    for (const r of responses) {
      expect(r.status).toBe(200);
    }
    const persistedCount = responses.filter((r) => r.body?.persisted === true).length;
    // Exactly one delivery wins the race and writes the row; the rest
    // observe the existing replay and respond `persisted: false`.
    expect(persistedCount).toBeLessThanOrEqual(1);

    const replays = await db
      .select()
      .from(schema.replaysTable)
      .where(sql`${schema.replaysTable.liveStreamId} = ${streamId}`);
    expect(replays).toHaveLength(1);
  }, 30_000);

  it("ignores non-'ready' state deliveries (queued/inprogress/error) without writing a replay", async () => {
    const streamId = await seedStream();
    const body = Buffer.from(
      JSON.stringify({
        uid: "vid-queued",
        status: { state: "inprogress" },
        meta: { streamId },
      }),
      "utf8",
    );
    const r = await request(app)
      .post("/api/streaming/webhooks/cloudflare")
      .set("Content-Type", "application/octet-stream")
      .set("Webhook-Signature", sign(body, WEBHOOK_SECRET))
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ignored: true, state: "inprogress" });
    const replays = await db
      .select()
      .from(schema.replaysTable)
      .where(sql`${schema.replaysTable.liveStreamId} = ${streamId}`);
    expect(replays).toHaveLength(0);
  });

  it("falls back to liveInput uid lookup when meta.streamId is missing", async () => {
    const streamId = `${TEST_PREFIX}str-${rid()}`;
    const cfInputId = `${TEST_PREFIX}input-fallback-${rid()}`;
    await db.insert(schema.streamsTable).values({
      id: streamId,
      hostName: "test-host",
      hostAvatar: "",
      title: "Fallback test",
      posterImage: "",
      sellerUserId: `${TEST_PREFIX}user-${rid()}`,
      cfInputId,
      provider: "cloudflare",
      status: "ended",
      endedAt: new Date(),
    });
    const body = Buffer.from(
      JSON.stringify({
        uid: "vid-fallback",
        status: { state: "ready" },
        duration: 30,
        thumbnail: "",
        playback: { hls: "https://videodelivery.net/vid-fallback/manifest/video.m3u8" },
        // No meta.streamId — must resolve via liveInput uid.
        liveInput: cfInputId,
      }),
      "utf8",
    );
    const r = await request(app)
      .post("/api/streaming/webhooks/cloudflare")
      .set("Content-Type", "application/octet-stream")
      .set("Webhook-Signature", sign(body, WEBHOOK_SECRET))
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, persisted: true });

    const replays = await db
      .select()
      .from(schema.replaysTable)
      .where(sql`${schema.replaysTable.liveStreamId} = ${streamId}`);
    expect(replays).toHaveLength(1);
  });

  it("hydrates missing playback.hls from CF API when payload arrives at the eventual-consistency edge", async () => {
    // CF "video ready" sometimes lands a beat before the playback URL
    // is fully provisioned. The handler must NOT persist a replay row
    // with an empty playbackUrl — it should re-fetch the video record
    // by uid via the streaming provider and merge the missing URL.
    // We stub getCloudflareVideo by monkey-patching the streaming
    // module — the integration test app is constructed AFTER the
    // import so the patch takes effect.
    const streamingMod = await import("../lib/streaming");
    const original = streamingMod.getCloudflareVideo;
    const stubbed = async (uid: string) => ({
      uid,
      hlsUrl: `https://videodelivery.net/${uid}/manifest/video.m3u8`,
      thumbnailUrl: `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg`,
      durationSeconds: 42,
      recordedAt: new Date().toISOString(),
    });
    Object.defineProperty(streamingMod, "getCloudflareVideo", {
      value: stubbed,
      configurable: true,
    });
    try {
      const streamId = await seedStream();
      // Payload deliberately omits playback — handler must fall back.
      const body = Buffer.from(
        JSON.stringify({
          uid: "vid-needs-hydration",
          status: { state: "ready" },
          duration: 0,
          meta: { streamId },
        }),
        "utf8",
      );
      const r = await request(app)
        .post("/api/streaming/webhooks/cloudflare")
        .set("Content-Type", "application/octet-stream")
        .set("Webhook-Signature", sign(body, WEBHOOK_SECRET))
        .send(body);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, persisted: true });

      const replays = await db
        .select()
        .from(schema.replaysTable)
        .where(sql`${schema.replaysTable.liveStreamId} = ${streamId}`);
      expect(replays).toHaveLength(1);
      // The hydrated URL — proving the fallback ran and the row didn't
      // land with an empty playbackUrl.
      expect(replays[0]!.playbackUrl).toBe(
        "https://videodelivery.net/vid-needs-hydration/manifest/video.m3u8",
      );
    } finally {
      Object.defineProperty(streamingMod, "getCloudflareVideo", {
        value: original,
        configurable: true,
      });
    }
  });

  it("acks 'unmatched_stream' for a webhook that doesn't correlate to any stream row", async () => {
    const body = Buffer.from(
      JSON.stringify({
        uid: "vid-orphan",
        status: { state: "ready" },
        duration: 30,
        playback: { hls: "https://example/playlist.m3u8" },
        meta: { streamId: `${TEST_PREFIX}does-not-exist` },
      }),
      "utf8",
    );
    const r = await request(app)
      .post("/api/streaming/webhooks/cloudflare")
      .set("Content-Type", "application/octet-stream")
      .set("Webhook-Signature", sign(body, WEBHOOK_SECRET))
      .send(body);
    expect(r.status).toBe(200);
    // The streamId in `meta` doesn't correspond to any row, so
    // persistReplayFromVideo returns persisted=false / replayId=null.
    // The handler still 200s (so CF doesn't disable the endpoint) and
    // logs `cf_stream_webhook_stream_not_found` for ops triage.
    expect(r.body).toMatchObject({ ok: true, persisted: false, replayId: null });
  });
});
