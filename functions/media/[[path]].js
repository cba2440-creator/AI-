export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/media\//, ""));

  if (!key) {
    return new Response("Not found", { status: 404 });
  }

  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(object.body, { headers });
}
