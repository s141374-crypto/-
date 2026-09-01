import { DurableObject } from "cloudflare:workers";

type Message = {
  id: string;
  text: string;
  createdAt: string;
};

type StoredMessage = {
  id: string;
  text: string;
  created_at: string;
};

type AddMessageResult =
  | { message: Message; error?: never }
  | { message?: never; error: "INVALID_MESSAGE" | "INVALID_CLIENT" | "INVALID_ID" | "RATE_LIMIT" };

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: JSON_HEADERS });
}

export class MessageRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 500),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);
        CREATE TABLE IF NOT EXISTS rate_limits (
          client_id TEXT PRIMARY KEY,
          window_start INTEGER NOT NULL,
          message_count INTEGER NOT NULL
        );
      `);
    });
  }

  getMessages(): Message[] {
    return this.ctx.storage.sql
      .exec<StoredMessage>("SELECT id, text, created_at FROM messages ORDER BY created_at DESC LIMIT 100")
      .toArray()
      .reverse()
      .map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at }));
  }

  addMessage(text: string, clientId: string, messageId: string, networkKey: string): AddMessageResult {
    const normalizedText = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    if (!normalizedText || normalizedText.length > 500) return { error: "INVALID_MESSAGE" };
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(clientId)) return { error: "INVALID_CLIENT" };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) return { error: "INVALID_ID" };

    const existing = this.ctx.storage.sql
      .exec<StoredMessage>("SELECT id, text, created_at FROM messages WHERE id = ?", messageId)
      .toArray()[0];
    if (existing) return { message: { id: existing.id, text: existing.text, createdAt: existing.created_at } };

    const now = Date.now();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const rateKeys = [[`client:${clientId}`, 10] as const, [`network:${networkKey}`, 30] as const];
    for (const [key, limit] of rateKeys) {
      const rate = this.ctx.storage.sql
        .exec<{ window_start: number; message_count: number }>("SELECT window_start, message_count FROM rate_limits WHERE client_id = ?", key)
        .toArray()[0];
      if (rate?.window_start === windowStart && rate.message_count >= limit) return { error: "RATE_LIMIT" };
    }
    for (const [key] of rateKeys) {
      this.ctx.storage.sql.exec(
        `INSERT INTO rate_limits (client_id, window_start, message_count)
         VALUES (?, ?, 1)
         ON CONFLICT(client_id) DO UPDATE SET
           window_start = excluded.window_start,
           message_count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.message_count + 1 ELSE 1 END`,
        key,
        windowStart
      );
    }

    const message: Message = {
      id: messageId,
      text: normalizedText,
      createdAt: new Date(now).toISOString()
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, text, created_at) VALUES (?, ?, ?)",
      message.id,
      message.text,
      message.createdAt
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY created_at DESC LIMIT 2000)"
    );
    return { message };
  }
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/messages") return json({ error: "找不到 API" }, 404);

  // Wrangler currently generates this namespace without its RPC generic; retain the
  // generated Env and narrow only this stub to the exported Durable Object class.
  const room = env.MESSAGE_ROOM.getByName("civic-notes-main") as DurableObjectStub<MessageRoom>;
  if (request.method === "GET") return json({ messages: await room.getMessages() });

  if (request.method === "POST") {
    if (request.headers.get("Origin") !== url.origin) return json({ error: "拒絕跨網站寫入" }, 403);
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "只接受 JSON" }, 415);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 4096) return json({ error: "留言內容過長" }, 413);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "請提供有效的 JSON" }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "留言格式錯誤" }, 400);
    const candidate = body as Record<string, unknown>;
    if (typeof candidate.text !== "string" || typeof candidate.clientId !== "string" || typeof candidate.messageId !== "string") {
      return json({ error: "留言格式錯誤" }, 400);
    }

    const address = request.headers.get("CF-Connecting-IP") || "unknown";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`civic-law-lab:${address}`));
    const networkKey = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
    const result = await room.addMessage(candidate.text, candidate.clientId, candidate.messageId, networkKey);
    if (result.error === "RATE_LIMIT") return json({ error: "送出太頻繁，請稍後再試" }, 429);
    if (result.error) return json({ error: "留言格式錯誤或超過 500 字" }, 400);
    return json({ message: result.message }, 201);
  }

  return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env);
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Frame-Options", "DENY");
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    } catch (error) {
      console.error(JSON.stringify({
        message: "request failed",
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error)
      }));
      return json({ error: "服務暫時無法使用" }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
