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
  | { message?: never; error: "INVALID_MESSAGE" | "INVALID_CLIENT" | "RATE_LIMIT" };

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

  addMessage(text: string, clientId: string): AddMessageResult {
    const normalizedText = text.trim();
    if (!normalizedText || normalizedText.length > 500) return { error: "INVALID_MESSAGE" };
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(clientId)) return { error: "INVALID_CLIENT" };

    const now = Date.now();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const rate = this.ctx.storage.sql
      .exec<{ window_start: number; message_count: number }>(
        "SELECT window_start, message_count FROM rate_limits WHERE client_id = ?",
        clientId
      )
      .toArray()[0];

    if (rate?.window_start === windowStart && rate.message_count >= 10) return { error: "RATE_LIMIT" };

    this.ctx.storage.sql.exec(
      `INSERT INTO rate_limits (client_id, window_start, message_count)
       VALUES (?, ?, 1)
       ON CONFLICT(client_id) DO UPDATE SET
         window_start = excluded.window_start,
         message_count = CASE
           WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.message_count + 1
           ELSE 1
         END`,
      clientId,
      windowStart
    );

    const message: Message = {
      id: crypto.randomUUID(),
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
      "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY created_at DESC LIMIT 200)"
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
    if (typeof candidate.text !== "string" || typeof candidate.clientId !== "string") {
      return json({ error: "留言格式錯誤" }, 400);
    }

    const result = await room.addMessage(candidate.text, candidate.clientId);
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
      return await env.ASSETS.fetch(request);
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
