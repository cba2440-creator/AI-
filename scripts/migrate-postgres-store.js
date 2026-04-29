const { Client } = require("pg");

function shouldUseSsl(connectionString, envPrefix) {
  const explicitSsl = String(process.env[`${envPrefix}_SSL`] || "").toLowerCase();
  const pgSslMode = String(process.env[`${envPrefix}_PGSSLMODE`] || "").toLowerCase();

  if (explicitSsl === "true" || pgSslMode === "require") {
    return true;
  }

  if (explicitSsl === "false" || pgSslMode === "disable") {
    return false;
  }

  try {
    const parsed = new URL(connectionString);
    const hostname = String(parsed.hostname || "").toLowerCase();
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  } catch {
    return connectionString.includes("render.com") || connectionString.includes("supabase.co");
  }
}

function buildClient(connectionString, envPrefix) {
  return new Client({
    connectionString,
    ssl: shouldUseSsl(connectionString, envPrefix) ? { rejectUnauthorized: false } : false
  });
}

async function ensureTable(client) {
  await client.query(
    "create table if not exists app_json_store (" +
      "storage_key text primary key," +
      "value jsonb not null," +
      "updated_at timestamptz not null default now()" +
    ")"
  );
}

async function main() {
  const sourceUrl = String(process.env.SOURCE_DATABASE_URL || "").trim();
  const targetUrl = String(process.env.TARGET_DATABASE_URL || "").trim();

  if (!sourceUrl) {
    throw new Error("SOURCE_DATABASE_URL is required");
  }

  if (!targetUrl) {
    throw new Error("TARGET_DATABASE_URL is required");
  }

  const sourceClient = buildClient(sourceUrl, "SOURCE_DATABASE");
  const targetClient = buildClient(targetUrl, "TARGET_DATABASE");

  await sourceClient.connect();
  await targetClient.connect();

  try {
    await ensureTable(sourceClient);
    await ensureTable(targetClient);

    const sourceResult = await sourceClient.query(
      "select storage_key, value, updated_at from app_json_store order by storage_key asc"
    );

    await targetClient.query("begin");
    for (const row of sourceResult.rows) {
      await targetClient.query(
        "insert into app_json_store (storage_key, value, updated_at) values ($1, $2::jsonb, $3) " +
          "on conflict (storage_key) do update set value = excluded.value, updated_at = excluded.updated_at",
        [row.storage_key, JSON.stringify(row.value), row.updated_at]
      );
    }
    await targetClient.query("commit");

    console.log(JSON.stringify({
      ok: true,
      migratedKeys: sourceResult.rows.map((row) => row.storage_key),
      count: sourceResult.rowCount
    }, null, 2));
  } catch (error) {
    try {
      await targetClient.query("rollback");
    } catch {}
    throw error;
  } finally {
    await sourceClient.end();
    await targetClient.end();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
