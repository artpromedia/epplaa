import {
  getVapidPublicKey,
  registerPushToken,
  deletePushToken,
} from "@workspace/api-client-react";

const SW_URL = `${import.meta.env.BASE_URL}sw-push.js`;

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getActiveSubscription(): Promise<{
  registration: ServiceWorkerRegistration;
  subscription: PushSubscription | null;
} | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const registration = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return { registration, subscription };
}

export async function enableWebPush(): Promise<boolean> {
  try {
    const ctx = await getActiveSubscription();
    if (!ctx) return false;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;
    let sub = ctx.subscription;
    if (!sub) {
      const { publicKey } = await getVapidPublicKey();
      if (!publicKey) return false;
      sub = await ctx.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });
    }
    const json = sub.toJSON();
    await registerPushToken({
      kind: "webpush",
      token: sub.endpoint,
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
      userAgent: navigator.userAgent,
    });
    return true;
  } catch (err) {
    console.warn("enableWebPush failed", err);
    return false;
  }
}

export async function disableWebPush(): Promise<void> {
  try {
    const ctx = await getActiveSubscription();
    if (!ctx?.subscription) return;
    const endpoint = ctx.subscription.endpoint;
    await ctx.subscription.unsubscribe();
    await deletePushToken({ token: endpoint });
  } catch (err) {
    console.warn("disableWebPush failed", err);
  }
}
