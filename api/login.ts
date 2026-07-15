import { createHash, timingSafeEqual } from "node:crypto";

const attempts = new Map<string, { count: number; resetAt: number }>();

function equalText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export default function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "只接受 POST 請求。" });
  }

  const accessCode = process.env.APP_ACCESS_CODE || "";
  if (!accessCode) {
    return res.status(500).json({ error: "登入服務尚未完成設定。" });
  }

  const now = Date.now();
  const client = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const usage = attempts.get(client);
  if (!usage || usage.resetAt <= now) {
    attempts.set(client, { count: 1, resetAt: now + 15 * 60 * 1000 });
  } else if (usage.count >= 10) {
    return res.status(429).json({ error: "嘗試次數過多，請 15 分鐘後再試。" });
  } else {
    usage.count += 1;
  }

  const password = String(req.body?.password || "");
  if (!equalText(password, accessCode)) {
    return res.status(401).json({ error: "密碼不正確。" });
  }

  attempts.delete(client);
  res.setHeader(
    "Set-Cookie",
    `shine_auth=${createHash("sha256").update(accessCode).digest("hex")}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
  return res.status(200).json({ ok: true });
}
