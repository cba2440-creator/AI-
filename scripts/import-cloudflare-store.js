const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_CONTEST_TYPE = "video";
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const WRANGLER_CONFIG_PATH = path.join(ROOT, "wrangler.toml");

function main() {
  const config = readWranglerConfig(WRANGLER_CONFIG_PATH);

  if (!config.databaseName) {
    throw new Error("Could not find d1 database_name in wrangler.toml");
  }

  if (!config.bucketName) {
    throw new Error("Could not find r2 bucket_name in wrangler.toml");
  }

  const state = readJson(path.join(DATA_DIR, "state.json"), {});
  const employees = readJson(path.join(DATA_DIR, "employees.json"), []);
  const videos = readJson(path.join(DATA_DIR, "videos.json"), []);
  const votes = readJson(path.join(DATA_DIR, "votes.json"), []);

  const mappedVideos = buildMappedVideos(videos);
  const normalizedState = buildState(state, mappedVideos);
  const sqlFilePath = writeImportSql({
    state: normalizedState,
    employees,
    videos: mappedVideos,
    votes
  });

  try {
    runWrangler([
      "wrangler",
      "d1",
      "execute",
      config.databaseName,
      "--remote",
      "--file",
      sqlFilePath
    ]);

    uploadMediaFiles(config.bucketName, mappedVideos);
  } finally {
    safelyDelete(sqlFilePath);
  }

  console.log("Cloudflare import completed.");
  console.log(`D1 database: ${config.databaseName}`);
  console.log(`R2 bucket: ${config.bucketName}`);
}

function readWranglerConfig(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const databaseName = matchTomlValue(raw, /database_name\s*=\s*"([^"]+)"/);
  const bucketName = matchTomlValue(raw, /bucket_name\s*=\s*"([^"]+)"/);
  return { databaseName, bucketName };
}

function matchTomlValue(content, pattern) {
  const match = content.match(pattern);
  return match ? match[1] : "";
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildMappedVideos(videos) {
  return (Array.isArray(videos) ? videos : []).map((video) => {
    const contestType = normalizeContestType(video.contestType);
    const localVideoUrl = String(video.localVideoUrl || "").trim();
    const mediaFileName = localVideoUrl ? path.basename(localVideoUrl) : "";
    const mediaKey = mediaFileName ? `${contestType}/${mediaFileName}` : "";

    return {
      id: sanitizeText(video.id),
      contestType,
      title: sanitizeText(video.title),
      submitter: sanitizeText(video.submitter),
      description: sanitizeText(video.description),
      musicCategory: contestType === "bgm" ? sanitizeText(video.musicCategory) : "",
      type: contestType === "bgm" ? "audio" : "youtube",
      url: sanitizeText(video.url),
      mediaFileName,
      mediaKey
    };
  }).filter((video) => video.id && video.title);
}

function buildState(state, videos) {
  const categoriesFromState = normalizeStringArray(state.musicCategories);
  const derivedCategories = categoriesFromState.length
    ? categoriesFromState
    : normalizeStringArray(
        videos
          .filter((video) => video.contestType === "bgm")
          .map((video) => video.musicCategory)
      );

  return {
    publicContestType: normalizeContestType(state.publicContestType),
    musicCategories: derivedCategories,
    votingClosedVideo: Boolean(state?.votingClosedByContestType?.video),
    votingClosedBgm: Boolean(state?.votingClosedByContestType?.bgm),
    resetVersion: Number.isFinite(Number(state.resetVersion)) ? Number(state.resetVersion) : 1,
    updatedAt: sanitizeText(state.updatedAt) || new Date().toISOString()
  };
}

function writeImportSql(payload) {
  const lines = [];
  const now = new Date().toISOString();

  lines.push("DELETE FROM votes;");
  lines.push("DELETE FROM employees;");
  lines.push("DELETE FROM videos;");
  lines.push("DELETE FROM contest_state;");

  lines.push(
    buildInsert("contest_state", [
      "id",
      "public_contest_type",
      "music_categories_json",
      "voting_closed_video",
      "voting_closed_bgm",
      "reset_version",
      "updated_at"
    ], [[
      1,
      payload.state.publicContestType,
      JSON.stringify(payload.state.musicCategories),
      payload.state.votingClosedVideo ? 1 : 0,
      payload.state.votingClosedBgm ? 1 : 0,
      payload.state.resetVersion,
      payload.state.updatedAt
    ]])
  );

  if (payload.employees.length) {
    lines.push(
      buildInsert(
        "employees",
        ["employee_number", "voter_name", "password", "created_at", "updated_at"],
        payload.employees
          .map((employee) => ({
            employeeNumber: sanitizeText(employee.employeeNumber),
            voterName: sanitizeText(employee.voterName),
            password: sanitizeText(employee.password)
          }))
          .filter((employee) => employee.employeeNumber && employee.voterName && employee.password)
          .map((employee) => [
            employee.employeeNumber,
            employee.voterName,
            employee.password,
            now,
            now
          ])
      )
    );
  }

  if (payload.videos.length) {
    lines.push(
      buildInsert(
        "videos",
        [
          "id",
          "contest_type",
          "title",
          "submitter",
          "description",
          "music_category",
          "type",
          "url",
          "media_key",
          "created_at",
          "updated_at"
        ],
        payload.videos.map((video) => [
          video.id,
          video.contestType,
          video.title,
          video.submitter,
          video.description,
          video.musicCategory,
          video.type,
          video.url,
          video.mediaKey,
          now,
          now
        ])
      )
    );
  }

  const validVideoIds = new Set(payload.videos.map((video) => video.id));
  if (payload.votes.length) {
    const voteRows = payload.votes
      .map((vote) => {
        const contestType = normalizeContestType(vote.contestType);
        const videoIds = uniqueStrings(vote.videoIds).filter((videoId) => validVideoIds.has(videoId));
        const selectionsByCategory =
          vote.selectionsByCategory && typeof vote.selectionsByCategory === "object"
            ? Object.fromEntries(
                Object.entries(vote.selectionsByCategory)
                  .map(([category, videoId]) => [sanitizeText(category), sanitizeText(videoId)])
                  .filter(([category, videoId]) => category && validVideoIds.has(videoId))
              )
            : {};

        if (!sanitizeText(vote.employeeNumber) || !videoIds.length) {
          return null;
        }

        return [
          sanitizeText(vote.employeeNumber),
          sanitizeText(vote.voterName),
          contestType,
          JSON.stringify(videoIds),
          JSON.stringify(selectionsByCategory),
          sanitizeText(vote.submittedAt) || now
        ];
      })
      .filter(Boolean);

    if (voteRows.length) {
      lines.push(
        buildInsert(
          "votes",
          [
            "employee_number",
            "voter_name",
            "contest_type",
            "video_ids_json",
            "selections_by_category_json",
            "submitted_at"
          ],
          voteRows
        )
      );
    }
  }

  const sqlFilePath = path.join(os.tmpdir(), `aiiparkmall-import-${Date.now()}.sql`);
  fs.writeFileSync(sqlFilePath, `${lines.join("\n\n")}\n`, "utf8");
  return sqlFilePath;
}

function buildInsert(tableName, columns, rows) {
  if (!rows.length) {
    return "";
  }

  return [
    `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES`,
    rows.map((row) => `  (${row.map(sqlValue).join(", ")})`).join(",\n"),
    ";"
  ].join("\n");
}

function sqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function uploadMediaFiles(bucketName, videos) {
  const uploaded = new Set();

  videos.forEach((video) => {
    if (!video.mediaFileName || !video.mediaKey) {
      return;
    }

    const sourcePath = path.join(UPLOADS_DIR, video.mediaFileName);
    if (!fs.existsSync(sourcePath)) {
      console.warn(`Skipping missing upload file: ${sourcePath}`);
      return;
    }

    if (uploaded.has(video.mediaKey)) {
      return;
    }

    runWrangler([
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucketName}/${video.mediaKey}`,
      "--file",
      sourcePath
    ]);

    uploaded.add(video.mediaKey);
  });
}

function runWrangler(args) {
  if (process.platform === "win32") {
    execFileSync("cmd.exe", ["/c", "npx", ...args], {
      cwd: ROOT,
      stdio: "inherit"
    });
    return;
  }

  execFileSync("npx", args, {
    cwd: ROOT,
    stdio: "inherit"
  });
}

function sanitizeText(value) {
  return String(value ?? "").trim();
}

function normalizeContestType(value) {
  const normalized = sanitizeText(value).toLowerCase();
  return normalized === "bgm" ? "bgm" : DEFAULT_CONTEST_TYPE;
}

function normalizeStringArray(values) {
  const seen = new Set();
  const result = [];

  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = sanitizeText(value);
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(normalized);
  });

  return result;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => sanitizeText(value)).filter(Boolean))];
}

function safelyDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

main();
