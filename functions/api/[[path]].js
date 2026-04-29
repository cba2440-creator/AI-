import * as XLSX from "../_vendor/xlsx.mjs";
import {
  CONTEST_TYPES,
  DEFAULT_CONTEST_TYPE,
  sanitizeText,
  normalizeContestType,
  getContestTypes,
  getContestLabel,
  normalizeMusicCategories,
  normalizeStatePayload,
  deriveMusicCategoriesFromVideos,
  stripLeadingNumber,
  jsonResponse,
  escapeFileName
} from "../_lib/contest.js";

const ADMIN_ERROR = "Invalid admin password.";
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac"]);
const VIDEO_EXTENSIONS = new Set([".mp4"]);

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/^\/api\/?/, "");
  const segments = pathname.split("/").filter(Boolean);

  try {
    if (!env.DB) {
      return jsonResponse({ message: "Missing D1 binding." }, 500);
    }

    if (request.method === "GET" && pathname === "videos") {
      return jsonResponse(await loadVideos(env));
    }

    if (request.method === "GET" && pathname === "meta") {
      return handleMeta(env, url);
    }

    if ((request.method === "GET" || request.method === "POST") && pathname === "eligible-voter") {
      return handleEligibleVoter(request, env, url);
    }

    if (request.method === "POST" && pathname === "vote") {
      return handleVoteSubmission(request, env);
    }

    if (segments[0] !== "admin") {
      return jsonResponse({ message: "Not found." }, 404);
    }

    if (!isAuthorized(request, env)) {
      return jsonResponse({ message: ADMIN_ERROR }, 401);
    }

    const adminSegments = segments.slice(1);

    if (request.method === "GET" && adminSegments[0] === "dashboard") {
      return handleAdminDashboard(env);
    }

    if (request.method === "POST" && adminSegments[0] === "public-contest") {
      return handlePublicContestUpdate(request, env);
    }

    if (request.method === "POST" && adminSegments[0] === "music-categories") {
      return handleMusicCategoriesUpdate(request, env);
    }

    if (request.method === "POST" && adminSegments[0] === "reset-votes") {
      return handleResetVotes(env, url);
    }

    if (request.method === "POST" && adminSegments[0] === "close-voting") {
      return handleVotingToggle(env, url, true);
    }

    if (request.method === "POST" && adminSegments[0] === "open-voting") {
      return handleVotingToggle(env, url, false);
    }

    if (request.method === "GET" && adminSegments[0] === "export-results") {
      return handleExportResults(env, url);
    }

    if (request.method === "GET" && adminSegments[0] === "video-import-template") {
      return buildWorkbookResponse(
        [
          ["contestType", "title", "submitter", "description", "musicCategory", "url"],
          ["video", "01. Sample Video", "Admin", "Video description", "", "https://www.youtube.com/watch?v=example"],
          ["bgm", "01. Sample Music", "Admin", "Music description", "Category A", ""]
        ],
        "ImportTemplate",
        "2026-contest-import-template.xlsx"
      );
    }

    if (request.method === "GET" && adminSegments[0] === "employee-import-template") {
      return buildWorkbookResponse(
        [
          ["employeeNumber", "name", "password4"],
          ["180012", "Sample User", "1234"]
        ],
        "Employees",
        "2026-ai-employee-import-template.xlsx"
      );
    }

    if (request.method === "POST" && adminSegments[0] === "import-videos") {
      return handleVideoImport(request, env);
    }

    if (request.method === "POST" && adminSegments[0] === "import-employees") {
      return handleEmployeeImport(request, env);
    }

    if (adminSegments[0] === "videos" && request.method === "POST" && adminSegments.length === 1) {
      return handleVideoCreate(request, env);
    }

    if (adminSegments[0] === "videos" && adminSegments[1]) {
      const videoId = decodeURIComponent(adminSegments[1]);
      if (request.method === "PUT" && adminSegments.length === 2) {
        return handleVideoUpdate(request, env, videoId);
      }
      if (request.method === "DELETE" && adminSegments.length === 2) {
        return handleVideoDelete(env, videoId);
      }
      if (request.method === "POST" && adminSegments[2] === "upload") {
        return handleVideoUpload(request, env, videoId);
      }
    }

    if (adminSegments[0] === "votes" && request.method === "DELETE" && adminSegments[1]) {
      return handleVoteDelete(env, decodeURIComponent(adminSegments[1]), url);
    }

    return jsonResponse({ message: "Not found." }, 404);
  } catch (error) {
    return jsonResponse({ message: sanitizeText(error?.message) || "Server error." }, 500);
  }
}

function isAuthorized(request, env) {
  const actual = sanitizeText(request.headers.get("x-admin-password"));
  const expected = sanitizeText(env.ADMIN_PASSWORD || "iparkmall1234");
  return Boolean(actual && expected && actual === expected);
}

async function handleMeta(env, url) {
  const videos = await loadVideos(env);
  const state = await loadState(env, videos);
  const contestType = normalizeContestType(url.searchParams.get("contestType"));
  return jsonResponse({
    contestTypes: getContestTypes(),
    publicContestType: state.publicContestType,
    musicCategories: state.musicCategories,
    votingClosed: Boolean(state.votingClosedByContestType[contestType]),
    votingClosedByContestType: state.votingClosedByContestType,
    resetVersion: state.resetVersion,
    updatedAt: state.updatedAt
  });
}

async function handleEligibleVoter(request, env, url) {
  const payload =
    request.method === "GET"
      ? {
          employeeNumber: url.searchParams.get("employeeNumber"),
          password: url.searchParams.get("password"),
          contestType: url.searchParams.get("contestType")
        }
      : await readJsonRequest(request);

  const employeeNumber = sanitizeText(payload.employeeNumber);
  const password = sanitizeText(payload.password);
  const employee = await getEmployeeByNumber(env, employeeNumber);

  if (!employee || employee.password !== password) {
    return jsonResponse({ message: "Invalid employee number or password." }, 401);
  }

  const videos = await loadVideos(env);
  const state = await loadState(env, videos);
  const votes = await loadVotes(env, videos);
  const votesByContestType = {};

  for (const contestType of CONTEST_TYPES) {
    const currentVote = votes.find(
      (vote) =>
        vote.employeeNumber === employeeNumber &&
        normalizeContestType(vote.contestType) === contestType.id
    );

    votesByContestType[contestType.id] = currentVote
      ? {
          hasVoted: true,
          videoIds: normalizeVoteVideoIds(currentVote),
          selectionsByCategory: buildSelectionsByCategory(currentVote, videos, state),
          submittedAt: currentVote.submittedAt
        }
      : {
          hasVoted: false,
          videoIds: [],
          selectionsByCategory: {},
          submittedAt: null
        };
  }

  const selectedContestType = normalizeContestType(payload.contestType);
  return jsonResponse({
    eligible: true,
    employeeNumber,
    voterName: employee.voterName,
    votesByContestType,
    ...votesByContestType[selectedContestType]
  });
}

async function handleVoteSubmission(request, env) {
  const payload = await readJsonRequest(request);
  const employeeNumber = sanitizeText(payload.employeeNumber);
  const password = sanitizeText(payload.password);
  const contestType = normalizeContestType(payload.contestType);
  const employee = await getEmployeeByNumber(env, employeeNumber);

  if (!employee || employee.password !== password) {
    return jsonResponse({ message: "Invalid employee number or password." }, 401);
  }

  const videos = await loadVideos(env);
  const state = await loadState(env, videos);
  if (state.votingClosedByContestType[contestType]) {
    return jsonResponse({ message: "Voting is closed for this contest." }, 403);
  }

  const existingVote = await getVoteByEmployeeAndContest(env, employeeNumber, contestType, videos);
  if (existingVote) {
    return jsonResponse({ message: "You have already voted." }, 409);
  }

  const contestVideos = videos.filter((video) => video.contestType === contestType);
  let videoIds = uniqueStrings(payload.videoIds);
  let selectionsByCategory = {};

  if (contestType === "bgm") {
    const categories = getMusicCategories(state, videos);
    const rawSelections =
      payload.selectionsByCategory && typeof payload.selectionsByCategory === "object"
        ? payload.selectionsByCategory
        : {};

    if (!categories.length) {
      return jsonResponse({ message: "Configure music categories first." }, 400);
    }

    selectionsByCategory = Object.fromEntries(
      categories.map((category) => [category, sanitizeText(rawSelections[category])])
    );

    if (Object.values(selectionsByCategory).some((videoId) => !videoId)) {
      return jsonResponse({ message: "Select one music item for each category." }, 400);
    }

    const invalidCategoryVote = categories.some((category) => {
      const selectedId = selectionsByCategory[category];
      return !contestVideos.some(
        (video) => video.id === selectedId && sanitizeText(video.musicCategory) === category
      );
    });

    if (invalidCategoryVote) {
      return jsonResponse({ message: "A selected track does not match its category." }, 400);
    }

    videoIds = categories.map((category) => selectionsByCategory[category]);
  } else if (videoIds.length !== 1) {
    return jsonResponse({ message: "Select exactly one item." }, 400);
  }

  if (!videoIds.every((videoId) => contestVideos.some((video) => video.id === videoId))) {
    return jsonResponse({ message: "Selected item not found." }, 400);
  }

  const submittedAt = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO votes (
        employee_number,
        voter_name,
        contest_type,
        video_ids_json,
        selections_by_category_json,
        submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      employeeNumber,
      employee.voterName,
      contestType,
      JSON.stringify(videoIds),
      JSON.stringify(selectionsByCategory),
      submittedAt
    )
    .run();

  return jsonResponse(
    {
      message: "Vote submitted.",
      voterName: employee.voterName,
      submittedAt
    },
    201
  );
}

async function handleAdminDashboard(env) {
  const [videos, employees] = await Promise.all([loadVideos(env), loadEmployees(env)]);
  const state = await loadState(env, videos);
  const votes = await loadVotes(env, videos);
  const resultsByContestType = {};

  for (const contestType of CONTEST_TYPES) {
    resultsByContestType[contestType.id] = buildResults(
      contestType.id,
      videos,
      votes,
      employees,
      state
    );
  }

  return jsonResponse({
    videos,
    votes,
    employees,
    meta: state,
    resultsByContestType
  });
}

async function handlePublicContestUpdate(request, env) {
  const payload = await readJsonRequest(request);
  const currentState = await loadState(env);
  const nextState = {
    ...currentState,
    publicContestType: normalizeContestType(payload.publicContestType),
    updatedAt: new Date().toISOString()
  };

  await saveState(env, nextState);
  return jsonResponse({
    message: "Public contest saved.",
    publicContestType: nextState.publicContestType
  });
}

async function handleMusicCategoriesUpdate(request, env) {
  const payload = await readJsonRequest(request);
  const currentState = await loadState(env);
  const categories = normalizeMusicCategories(payload.categories);
  const nextState = {
    ...currentState,
    musicCategories: categories,
    updatedAt: new Date().toISOString()
  };

  await saveState(env, nextState);
  return jsonResponse({
    message: "Music categories saved.",
    categories
  });
}

async function handleResetVotes(env, url) {
  const contestType = normalizeContestType(url.searchParams.get("contestType"));
  await env.DB.prepare("DELETE FROM votes WHERE contest_type = ?").bind(contestType).run();
  return jsonResponse({ message: `Votes reset for ${contestType}.` });
}

async function handleVotingToggle(env, url, closed) {
  const contestType = normalizeContestType(url.searchParams.get("contestType"));
  const currentState = await loadState(env);
  const nextState = {
    ...currentState,
    votingClosedByContestType: {
      ...currentState.votingClosedByContestType,
      [contestType]: closed
    },
    updatedAt: new Date().toISOString()
  };

  await saveState(env, nextState);
  return jsonResponse({
    message: closed ? "Voting closed." : "Voting reopened.",
    votingClosedByContestType: nextState.votingClosedByContestType
  });
}

async function handleVideoCreate(request, env) {
  const payload = normalizeVideoPayload(await readJsonRequest(request));
  if (!payload) {
    return jsonResponse({ message: "Invalid item payload." }, 400);
  }

  const videos = await loadVideos(env);
  const id = createVideoId(payload.title, videos);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `
      INSERT INTO videos (
        id, contest_type, title, submitter, description, music_category,
        type, url, media_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      payload.contestType,
      payload.title,
      payload.submitter,
      payload.description,
      payload.musicCategory,
      payload.type,
      payload.url,
      "",
      now,
      now
    )
    .run();

  const video = await getVideoById(env, id);
  return jsonResponse({ message: "Item created.", video }, 201);
}

async function handleVideoUpdate(request, env, id) {
  const existing = await getRawVideoById(env, id);
  if (!existing) {
    return jsonResponse({ message: "Item not found." }, 404);
  }

  const payload = normalizeVideoPayload(await readJsonRequest(request));
  if (!payload) {
    return jsonResponse({ message: "Invalid item payload." }, 400);
  }

  await env.DB.prepare(
    `
      UPDATE videos
      SET contest_type = ?, title = ?, submitter = ?, description = ?,
          music_category = ?, type = ?, url = ?, updated_at = ?
      WHERE id = ?
    `
  )
    .bind(
      payload.contestType,
      payload.title,
      payload.submitter,
      payload.description,
      payload.musicCategory,
      payload.type,
      payload.url,
      new Date().toISOString(),
      id
    )
    .run();

  const video = await getVideoById(env, id);
  return jsonResponse({ message: "Item updated.", video });
}

async function handleVideoDelete(env, id) {
  const video = await getRawVideoById(env, id);
  if (!video) {
    return jsonResponse({ message: "Item not found." }, 404);
  }

  if (video.media_key && env.MEDIA_BUCKET) {
    await env.MEDIA_BUCKET.delete(video.media_key);
  }

  await env.DB.prepare("DELETE FROM videos WHERE id = ?").bind(id).run();
  await reconcileVotesForMissingVideos(env);
  return jsonResponse({ message: "Item deleted." });
}

async function handleVideoUpload(request, env, id) {
  const video = await getRawVideoById(env, id);
  if (!video) {
    return jsonResponse({ message: "Item not found." }, 404);
  }
  if (!env.MEDIA_BUCKET) {
    return jsonResponse({ message: "Missing R2 binding." }, 500);
  }

  const formData = await request.formData();
  const file = formData.get("videoFile");
  if (!(file instanceof File)) {
    return jsonResponse({ message: "Select a file to upload." }, 400);
  }

  const extension = getSafeExtension(file.name, video.contest_type);
  const allowed = video.contest_type === "bgm" ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS;
  if (!allowed.has(extension)) {
    return jsonResponse({ message: "Unsupported file type." }, 400);
  }

  const mediaKey = `${video.contest_type}/${id}-${Date.now()}${extension}`;
  await env.MEDIA_BUCKET.put(mediaKey, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || guessMimeType(extension) }
  });

  if (video.media_key) {
    await env.MEDIA_BUCKET.delete(video.media_key);
  }

  await env.DB.prepare("UPDATE videos SET media_key = ?, updated_at = ? WHERE id = ?")
    .bind(mediaKey, new Date().toISOString(), id)
    .run();

  return jsonResponse({
    message: "File uploaded.",
    localVideoUrl: `/media/${mediaKey}`
  });
}

async function handleVoteDelete(env, employeeNumber, url) {
  const contestType = normalizeContestType(url.searchParams.get("contestType"));
  const result = await env.DB.prepare(
    "DELETE FROM votes WHERE employee_number = ? AND contest_type = ?"
  )
    .bind(employeeNumber, contestType)
    .run();

  if (!result.meta?.changes) {
    return jsonResponse({ message: "Vote not found." }, 404);
  }

  return jsonResponse({ message: `Vote deleted for ${contestType}.` });
}

async function handleExportResults(env, url) {
  const contestType = normalizeContestType(url.searchParams.get("contestType"));
  const [videos, employees] = await Promise.all([loadVideos(env), loadEmployees(env)]);
  const state = await loadState(env, videos);
  const votes = await loadVotes(env, videos);
  const workbook = buildResultsWorkbook(contestType, videos, votes, employees, state);
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const fileName = `2026-${contestType}-contest-results.xlsx`;

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${escapeFileName(fileName)}`,
      "Cache-Control": "no-store"
    }
  });
}

async function handleVideoImport(request, env) {
  const formData = await request.formData();
  const file = formData.get("videoSheet");
  if (!(file instanceof File)) {
    return jsonResponse({ message: "Select an Excel file." }, 400);
  }

  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) {
    return jsonResponse({ message: "No rows found." }, 400);
  }

  const importedVideos = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    const payload = normalizeVideoPayload({
      contestType: row.contestType || row.contest || row.type,
      title: row.title,
      submitter: row.submitter,
      description: row.description,
      musicCategory: row.musicCategory,
      url: row.url
    });

    if (!payload) {
      continue;
    }

    importedVideos.push({
      id: createVideoId(payload.title, importedVideos),
      ...payload,
      mediaKey: "",
      createdAt: now,
      updatedAt: now
    });
  }

  if (!importedVideos.length) {
    return jsonResponse({ message: "No valid rows found." }, 400);
  }

  await env.DB.prepare("DELETE FROM videos").run();
  for (const video of importedVideos) {
    await env.DB.prepare(
      `
        INSERT INTO videos (
          id, contest_type, title, submitter, description, music_category,
          type, url, media_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
      .bind(
        video.id,
        video.contestType,
        video.title,
        video.submitter,
        video.description,
        video.musicCategory,
        video.type,
        video.url,
        video.mediaKey,
        video.createdAt,
        video.updatedAt
      )
      .run();
  }

  await reconcileVotesForMissingVideos(env);
  return jsonResponse(
    {
      message: `${importedVideos.length} items imported.`,
      count: importedVideos.length,
      videos: importedVideos.map((video) => ({ ...video, localVideoUrl: "" }))
    },
    201
  );
}

async function handleEmployeeImport(request, env) {
  const formData = await request.formData();
  const file = formData.get("employeeSheet");
  if (!(file instanceof File)) {
    return jsonResponse({ message: "Select an Excel file." }, 400);
  }

  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) {
    return jsonResponse({ message: "No rows found." }, 400);
  }

  const employees = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    const payload = normalizeEmployeePayload({
      employeeNumber: row.employeeNumber || row["employeeNumber"] || row["saweon"] || row["number"],
      voterName: row.voterName || row.name || row["name"],
      password: row.password || row.password4 || row["password4"] || row["password"]
    });

    if (!payload || employees.some((employee) => employee.employeeNumber === payload.employeeNumber)) {
      continue;
    }
    employees.push(payload);
  }

  if (!employees.length) {
    return jsonResponse({ message: "No valid employees found." }, 400);
  }

  await env.DB.prepare("DELETE FROM employees").run();
  for (const employee of employees) {
    await env.DB.prepare(
      `
        INSERT INTO employees (
          employee_number, voter_name, password, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `
    )
      .bind(employee.employeeNumber, employee.voterName, employee.password, now, now)
      .run();
  }

  await reconcileVotesForMissingEmployees(env);
  return jsonResponse(
    {
      message: `${employees.length} employees imported.`,
      count: employees.length
    },
    201
  );
}

async function loadState(env, videos = null) {
  const row = await env.DB.prepare("SELECT * FROM contest_state WHERE id = 1").first();
  const normalized = normalizeStatePayload({
    publicContestType: row?.public_contest_type || DEFAULT_CONTEST_TYPE,
    musicCategories: safeJsonParse(row?.music_categories_json, []),
    votingClosedByContestType: {
      video: Boolean(row?.voting_closed_video),
      bgm: Boolean(row?.voting_closed_bgm)
    },
    resetVersion: row?.reset_version || 1,
    updatedAt: row?.updated_at
  });

  if (!normalized.musicCategories.length) {
    normalized.musicCategories = deriveMusicCategoriesFromVideos(
      Array.isArray(videos) ? videos : await loadVideos(env)
    );
  }

  return normalized;
}

async function saveState(env, state) {
  const normalized = normalizeStatePayload(state);
  await env.DB.prepare(
    `
      INSERT INTO contest_state (
        id, public_contest_type, music_categories_json,
        voting_closed_video, voting_closed_bgm, reset_version, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        public_contest_type = excluded.public_contest_type,
        music_categories_json = excluded.music_categories_json,
        voting_closed_video = excluded.voting_closed_video,
        voting_closed_bgm = excluded.voting_closed_bgm,
        reset_version = excluded.reset_version,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      normalized.publicContestType,
      JSON.stringify(normalized.musicCategories),
      normalized.votingClosedByContestType.video ? 1 : 0,
      normalized.votingClosedByContestType.bgm ? 1 : 0,
      normalized.resetVersion,
      normalized.updatedAt
    )
    .run();
}

async function loadVideos(env) {
  const rows = await env.DB.prepare("SELECT * FROM videos ORDER BY created_at ASC, id ASC").all();
  return (rows.results || []).map(mapVideoRow);
}

async function getRawVideoById(env, id) {
  return env.DB.prepare("SELECT * FROM videos WHERE id = ?").bind(id).first();
}

async function getVideoById(env, id) {
  const row = await getRawVideoById(env, id);
  return row ? mapVideoRow(row) : null;
}

async function loadEmployees(env) {
  const rows = await env.DB.prepare("SELECT * FROM employees ORDER BY employee_number ASC").all();
  return (rows.results || []).map((row) => ({
    employeeNumber: sanitizeText(row.employee_number),
    voterName: sanitizeText(row.voter_name),
    password: sanitizeText(row.password)
  }));
}

async function getEmployeeByNumber(env, employeeNumber) {
  const row = await env.DB.prepare("SELECT * FROM employees WHERE employee_number = ?")
    .bind(employeeNumber)
    .first();
  return row
    ? {
        employeeNumber: sanitizeText(row.employee_number),
        voterName: sanitizeText(row.voter_name),
        password: sanitizeText(row.password)
      }
    : null;
}

async function loadVotes(env, videos = null) {
  const sourceVideos = Array.isArray(videos) ? videos : await loadVideos(env);
  const rows = await env.DB.prepare("SELECT * FROM votes ORDER BY submitted_at DESC, id DESC").all();
  return (rows.results || []).map((row) => mapVoteRow(row, sourceVideos));
}

async function getVoteByEmployeeAndContest(env, employeeNumber, contestType, videos = null) {
  const row = await env.DB.prepare(
    "SELECT * FROM votes WHERE employee_number = ? AND contest_type = ?"
  )
    .bind(employeeNumber, contestType)
    .first();

  if (!row) {
    return null;
  }

  const sourceVideos = Array.isArray(videos) ? videos : await loadVideos(env);
  return mapVoteRow(row, sourceVideos);
}

function mapVideoRow(row) {
  const contestType = normalizeContestType(row.contest_type);
  return {
    id: sanitizeText(row.id),
    contestType,
    title: sanitizeText(row.title),
    submitter: sanitizeText(row.submitter),
    description: sanitizeText(row.description),
    lyrics: "",
    musicCategory: contestType === "bgm" ? sanitizeText(row.music_category) : "",
    type: contestType === "bgm" ? "audio" : "youtube",
    url: sanitizeText(row.url),
    localVideoUrl: sanitizeText(row.media_key) ? `/media/${sanitizeText(row.media_key)}` : ""
  };
}

function mapVoteRow(row, videos = []) {
  const contestType = normalizeContestType(row.contest_type);
  const vote = {
    employeeNumber: sanitizeText(row.employee_number),
    voterName: sanitizeText(row.voter_name),
    contestType,
    videoIds: uniqueStrings(safeJsonParse(row.video_ids_json, [])),
    selectionsByCategory: safeJsonParse(row.selections_by_category_json, {}),
    submittedAt: sanitizeText(row.submitted_at)
  };

  vote.selectionsByCategory =
    contestType === "bgm" ? buildSelectionsByCategory(vote, videos) : {};
  return vote;
}

function buildResults(contestType, videos, votes, employees, state) {
  const contestVideos = videos.filter((video) => video.contestType === contestType);
  const contestVotes = votes.filter((vote) => normalizeContestType(vote.contestType) === contestType);
  const totalSelections = contestVotes.reduce((sum, vote) => sum + normalizeVoteVideoIds(vote).length, 0);
  const voteCounts = {};

  contestVotes.forEach((vote) => {
    normalizeVoteVideoIds(vote).forEach((videoId) => {
      voteCounts[videoId] = (voteCounts[videoId] || 0) + 1;
    });
  });

  const result = {
    totalEligible: employees.length,
    totalVoters: contestVotes.length,
    totalSelections,
    voteCounts,
    categorySummaries: {}
  };

  if (contestType === "bgm") {
    getMusicCategories(state, contestVideos).forEach((category) => {
      const selectedIds = contestVotes
        .map((vote) => buildSelectionsByCategory(vote, contestVideos, state)[category])
        .filter(Boolean);
      const counts = {};
      selectedIds.forEach((videoId) => {
        counts[videoId] = (counts[videoId] || 0) + 1;
      });
      result.categorySummaries[category] = {
        totalSelections: selectedIds.length,
        voteCounts: counts
      };
    });
  }

  return result;
}

function buildResultsWorkbook(contestType, videos, votes, employees, state) {
  const contestLabel = getContestLabel(contestType);
  const contestVideos = videos.filter((video) => video.contestType === contestType);
  const contestVotes = votes.filter((vote) => vote.contestType === contestType);
  const results = buildResults(contestType, videos, votes, employees, state);
  const workbook = XLSX.utils.book_new();
  const summaryRows = [
    ["Contest", contestLabel],
    ["Eligible", results.totalEligible],
    ["Voters", results.totalVoters],
    ["Selections", results.totalSelections],
    []
  ];

  if (contestType === "bgm") {
    getMusicCategories(state, contestVideos).forEach((category) => {
      const categoryVideos = contestVideos.filter((video) => video.musicCategory === category);
      const categorySummary = results.categorySummaries[category] || {
        totalSelections: 0,
        voteCounts: {}
      };
      summaryRows.push([category, "", "", ""]);
      summaryRows.push(["No", "Title", "Votes", "Share"]);

      if (!categoryVideos.length) {
        summaryRows.push(["", "No entries", "", ""]);
      } else {
        categoryVideos.forEach((video, index) => {
          const count = categorySummary.voteCounts[video.id] || 0;
          const percentage = categorySummary.totalSelections ? Math.round((count / categorySummary.totalSelections) * 100) : 0;
          summaryRows.push([
            String(index + 1).padStart(2, "0"),
            stripLeadingNumber(video.title),
            count,
            `${percentage}%`
          ]);
        });
      }

      summaryRows.push([]);
    });
  } else {
    summaryRows.push(["No", "Title", "Votes", "Share"]);
    contestVideos.forEach((video, index) => {
      const count = results.voteCounts[video.id] || 0;
      const percentage = results.totalSelections ? Math.round((count / results.totalSelections) * 100) : 0;
      summaryRows.push([
        String(index + 1).padStart(2, "0"),
        stripLeadingNumber(video.title),
        count,
        `${percentage}%`
      ]);
    });
  }

  const voteRows =
    contestType === "bgm"
      ? [["Contest", "Employee", "Name", "Category", "Selection", "SubmittedAt"]]
      : [["Contest", "Employee", "Name", "Selection", "SubmittedAt"]];

  contestVotes.forEach((vote) => {
    if (contestType === "bgm") {
      Object.entries(buildSelectionsByCategory(vote, contestVideos, state)).forEach(([category, videoId]) => {
        const video = contestVideos.find((item) => item.id === videoId);
        voteRows.push([
          contestLabel,
          vote.employeeNumber,
          vote.voterName,
          category,
          video ? stripLeadingNumber(video.title) : videoId,
          vote.submittedAt
        ]);
      });
    } else {
      const selectedId = normalizeVoteVideoIds(vote)[0] || "";
      const video = contestVideos.find((item) => item.id === selectedId);
      voteRows.push([
        contestLabel,
        vote.employeeNumber,
        vote.voterName,
        video ? stripLeadingNumber(video.title) : selectedId,
        vote.submittedAt
      ]);
    }
  });

  const pendingRows = [["Contest", "Employee", "Name", "Status"]];
  const votedEmployeeNumbers = new Set(contestVotes.map((vote) => vote.employeeNumber));
  employees
    .filter((employee) => !votedEmployeeNumbers.has(employee.employeeNumber))
    .forEach((employee) => {
      pendingRows.push([contestLabel, employee.employeeNumber, employee.voterName, "Pending"]);
    });

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "Summary");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(voteRows), "Votes");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(pendingRows), "Pending");
  return workbook;
}

function buildSelectionsByCategory(vote, videos = [], state = null) {
  if (!vote || normalizeContestType(vote.contestType) !== "bgm") {
    return {};
  }

  const saved =
    vote.selectionsByCategory && typeof vote.selectionsByCategory === "object"
      ? Object.fromEntries(
          Object.entries(vote.selectionsByCategory)
            .map(([category, videoId]) => [sanitizeText(category), sanitizeText(videoId)])
            .filter(([category, videoId]) => category && videoId)
        )
      : {};

  if (Object.keys(saved).length) {
    return saved;
  }

  const derived = {};
  const videosById = new Map(videos.map((video) => [video.id, video]));
  normalizeVoteVideoIds(vote).forEach((videoId) => {
    const video = videosById.get(videoId);
    if (video?.musicCategory) {
      derived[video.musicCategory] = video.id;
    }
  });

  const categories = getMusicCategories(state, videos);
  if (!categories.length) {
    return derived;
  }

  return Object.fromEntries(
    categories
      .filter((category) => derived[category])
      .map((category) => [category, derived[category]])
  );
}

function getMusicCategories(state, videos) {
  const stored = normalizeMusicCategories(state?.musicCategories);
  if (stored.length) {
    return stored;
  }
  return deriveMusicCategoriesFromVideos(videos || []);
}

async function reconcileVotesForMissingVideos(env) {
  const videos = await loadVideos(env);
  const validIds = new Set(videos.map((video) => video.id));
  const votes = await loadVotes(env, videos);

  for (const vote of votes) {
    const nextVideoIds = normalizeVoteVideoIds(vote).filter((videoId) => validIds.has(videoId));
    if (!nextVideoIds.length) {
      await env.DB.prepare("DELETE FROM votes WHERE employee_number = ? AND contest_type = ?")
        .bind(vote.employeeNumber, vote.contestType)
        .run();
      continue;
    }

    const nextSelections =
      vote.contestType === "bgm"
        ? Object.fromEntries(
            Object.entries(buildSelectionsByCategory(vote, videos)).filter(([, videoId]) => validIds.has(videoId))
          )
        : {};

    await env.DB.prepare(
      `
        UPDATE votes
        SET video_ids_json = ?, selections_by_category_json = ?
        WHERE employee_number = ? AND contest_type = ?
      `
    )
      .bind(
        JSON.stringify(nextVideoIds),
        JSON.stringify(nextSelections),
        vote.employeeNumber,
        vote.contestType
      )
      .run();
  }
}

async function reconcileVotesForMissingEmployees(env) {
  const employees = await loadEmployees(env);
  const validEmployeeNumbers = new Set(employees.map((employee) => employee.employeeNumber));
  const votes = await loadVotes(env);

  for (const vote of votes) {
    if (!validEmployeeNumbers.has(vote.employeeNumber)) {
      await env.DB.prepare("DELETE FROM votes WHERE employee_number = ? AND contest_type = ?")
        .bind(vote.employeeNumber, vote.contestType)
        .run();
    }
  }
}

function normalizeVideoPayload(payload) {
  const contestType = normalizeContestType(payload.contestType);
  const title = sanitizeText(payload.title);
  const submitter = sanitizeText(payload.submitter);
  const description = sanitizeText(payload.description);
  const musicCategory = contestType === "bgm" ? sanitizeText(payload.musicCategory) : "";
  const type = contestType === "bgm" ? "audio" : "youtube";
  const url = sanitizeText(payload.url);

  if (!title || !submitter || !description) {
    return null;
  }
  if (contestType === "video" && !url) {
    return null;
  }
  if (contestType === "bgm" && !musicCategory) {
    return null;
  }

  return {
    contestType,
    title,
    submitter,
    description,
    lyrics: "",
    musicCategory,
    type,
    url
  };
}

function normalizeEmployeePayload(payload) {
  const employeeNumber = sanitizeText(payload.employeeNumber);
  const voterName = sanitizeText(payload.voterName);
  const password = sanitizeText(payload.password);

  if (!employeeNumber || !voterName || !/^\d{4}$/.test(password)) {
    return null;
  }

  return { employeeNumber, voterName, password };
}

function createVideoId(title, existingVideos) {
  const items = Array.isArray(existingVideos) ? existingVideos : [];
  const base =
    sanitizeText(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "video";
  let candidate = base;
  let suffix = 2;

  while (items.some((video) => sanitizeText(video.id) === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function normalizeVoteVideoIds(vote) {
  if (Array.isArray(vote?.videoIds)) {
    return uniqueStrings(vote.videoIds);
  }
  if (sanitizeText(vote?.videoId)) {
    return [sanitizeText(vote.videoId)];
  }
  return [];
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => sanitizeText(value)).filter(Boolean))];
}

async function readJsonRequest(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function getSafeExtension(fileName, contestType) {
  const matched = /\.[^.]+$/.exec(String(fileName || "").toLowerCase());
  if (matched?.[0]) {
    return matched[0];
  }
  return contestType === "bgm" ? ".mp3" : ".mp4";
}

function guessMimeType(extension) {
  switch (extension) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

function buildWorkbookResponse(rows, sheetName, fileName) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${escapeFileName(fileName)}`,
      "Cache-Control": "no-store"
    }
  });
}
