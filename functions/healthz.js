import { jsonResponse } from "./_lib/contest.js";

export async function onRequest(context) {
  const { env } = context;
  return jsonResponse({
    ok: true,
    backend: "cloudflare-pages-functions",
    hasDatabase: Boolean(env.DB),
    hasMediaBucket: Boolean(env.MEDIA_BUCKET)
  });
}
