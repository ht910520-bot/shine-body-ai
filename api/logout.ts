export default function handler(_req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", "shine_auth=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
  return res.status(200).json({ ok: true });
}
