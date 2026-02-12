export async function dispatchWebhook(
  url: string,
  secret: string | undefined,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  const body = JSON.stringify({ event, data: payload, timestamp: Date.now() });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (secret) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body)
    );
    headers["X-Webhook-Signature"] = btoa(
      String.fromCharCode(...new Uint8Array(sig))
    );
  }

  try {
    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) {
      console.error(`Webhook ${event} failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error(`Webhook ${event} error:`, err);
  }
}
