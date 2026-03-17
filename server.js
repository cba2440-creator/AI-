const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { URL } = require("url");
const XLSX = require("xlsx");
const Busboy = require("busboy");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "iparkmall2020!";
const ROOT = __dirname;
const DEFAULT_RENDER_DATA_DIR = "/var/data/ai-promotion-awards";
const DEFAULT_LOCAL_DATA_DIR = path.join(ROOT, "data");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const USE_DATABASE_STORAGE = Boolean(DATABASE_URL);
const REQUIRE_PERSISTENT_DATA =
  String(
    process.env.REQUIRE_PERSISTENT_DATA ??
      (process.env.RENDER || process.env.RENDER_EXTERNAL_URL ? "true" : "false")
  ).toLowerCase() === "true";
const CONFIGURED_DATA_DIR =
  USE_DATABASE_STORAGE
    ? DEFAULT_LOCAL_DATA_DIR
    : (
      process.env.DATA_DIR ||
      process.env.RENDER_DISK_MOUNT_PATH ||
      (process.env.RENDER || process.env.RENDER_EXTERNAL_URL ? DEFAULT_RENDER_DATA_DIR : DEFAULT_LOCAL_DATA_DIR)
    );
const REQUESTED_DATA_DIR = path.isAbsolute(CONFIGURED_DATA_DIR)
  ? CONFIGURED_DATA_DIR
  : path.join(ROOT, CONFIGURED_DATA_DIR);
const DATA_DIR = resolveWritableDataDir(REQUESTED_DATA_DIR);
const USING_FALLBACK_DATA_DIR = DATA_DIR !== REQUESTED_DATA_DIR;
if (!USE_DATABASE_STORAGE && REQUIRE_PERSISTENT_DATA && USING_FALLBACK_DATA_DIR) {
  throw new Error(`Persistent writable data storage is required. requested=${REQUESTED_DATA_DIR} actual=${DATA_DIR}`);
}
const VIDEOS_PATH = path.join(DATA_DIR, "videos.json");
const VOTES_PATH = path.join(DATA_DIR, "votes.json");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const EMPLOYEES_PATH = path.join(DATA_DIR, "employees.json");
const MEDIA_DIR = path.join(DATA_DIR, "uploads");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MEDIA_BACKUP_DIR = path.join(BACKUP_DIR, "uploads");
const JSON_BACKUP_RETENTION = 40;
const MEDIA_BACKUP_RETENTION = 20;
const STORAGE_KEY_BY_PATH = new Map();
const databaseState = {
  initialized: false,
  cache: {
    videos: null,
    votes: null,
    state: null,
    employees: null
  }
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

STORAGE_KEY_BY_PATH.set(VIDEOS_PATH, "videos");
STORAGE_KEY_BY_PATH.set(VOTES_PATH, "votes");
STORAGE_KEY_BY_PATH.set(STATE_PATH, "state");
STORAGE_KEY_BY_PATH.set(EMPLOYEES_PATH, "employees");

initializeStorage();

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === "/api/videos" && request.method === "GET") {
    return sendJson(response, 200, readJson(VIDEOS_PATH));
  }

  if (pathname === "/api/meta" && request.method === "GET") {
    return sendJson(response, 200, readJson(STATE_PATH));
  }

  if (pathname === "/api/results" && request.method === "GET") {
    return sendJson(response, 200, buildResults());
  }

  if (pathname === "/api/eligible-voter" && request.method === "GET") {
    return handleEligibleVoterLookup(response, requestUrl.searchParams);
  }

  if (pathname === "/api/vote" && request.method === "POST") {
    return handleVote(request, response);
  }

  if (pathname === "/api/vote" && request.method === "PUT") {
    return sendJson(response, 405, { message: "투표 변경은 지원하지 않습니다." });
  }

  if (pathname === "/api/admin/dashboard" && request.method === "GET") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return sendJson(response, 200, {
      videos: readJson(VIDEOS_PATH),
      votes: readJson(VOTES_PATH),
      results: buildResults(),
      meta: readJson(STATE_PATH)
    });
  }

  if (pathname === "/api/admin/videos" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleVideoCreate(request, response);
  }

  if (pathname.startsWith("/api/admin/videos/") && request.method === "PUT") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleVideoUpdate(request, response, pathname.split("/").pop());
  }

  if (pathname.startsWith("/api/admin/videos/") && request.method === "DELETE") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleVideoDelete(response, pathname.split("/").pop());
  }

  if (pathname.match(/^\/api\/admin\/videos\/[^/]+\/upload$/) && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    const parts = pathname.split("/");
    const videoId = parts[parts.length - 2];
    return handleVideoUpload(request, response, videoId);
  }

  if (pathname.startsWith("/api/admin/votes/") && request.method === "DELETE") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleVoteDelete(response, pathname.split("/").pop());
  }

  if (pathname === "/api/admin/reset-votes" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    const state = readJson(STATE_PATH);
    writeJson(VOTES_PATH, []);
    writeJson(STATE_PATH, {
      ...state,
      resetVersion: (state.resetVersion || 0) + 1,
      updatedAt: new Date().toISOString()
    });
    return sendJson(response, 200, { message: "전체 투표가 초기화되었습니다." });
  }

  if (pathname === "/api/admin/close-voting" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    const state = readJson(STATE_PATH);
    writeJson(STATE_PATH, {
      ...state,
      votingClosed: true,
      updatedAt: new Date().toISOString()
    });
    return sendJson(response, 200, { message: "마감되었습니다." });
  }

  if (pathname === "/api/admin/open-voting" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    const state = readJson(STATE_PATH);
    writeJson(STATE_PATH, {
      ...state,
      votingClosed: false,
      updatedAt: new Date().toISOString()
    });
    return sendJson(response, 200, { message: "마감 해제되었습니다." });
  }

  if (pathname === "/api/admin/export-results" && request.method === "GET") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleExportResults(response);
  }

  if (pathname === "/api/admin/video-import-template" && request.method === "GET") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleVideoImportTemplate(response);
  }

  if (pathname === "/api/admin/import-videos" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleVideoImport(request, response);
  }

  if (pathname === "/api/admin/employee-import-template" && request.method === "GET") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "愿由ъ옄 鍮꾨?踰덊샇媛 ?щ컮瑜댁? ?딆뒿?덈떎." });
    }

    return handleEmployeeImportTemplate(response);
  }

  if (pathname === "/api/admin/import-employees" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "愿由ъ옄 鍮꾨?踰덊샇媛 ?щ컮瑜댁? ?딆뒿?덈떎." });
    }

    return handleEmployeeImport(request, response);
  }

  if (pathname === "/api/admin/storage-status" && request.method === "GET") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return sendJson(response, 200, getStorageStatus());
  }

  if (pathname === "/api/admin/backups/videos" && request.method === "GET") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return sendJson(response, 200, { backups: listJsonBackups("videos") });
  }

  if (pathname === "/api/admin/backups/videos/restore-latest" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleRestoreLatestVideosBackup(response);
  }

  if (pathname === "/healthz" && request.method === "GET") {
    return sendJson(response, 200, { ok: true });
  }

  if (pathname.startsWith("/media/") && request.method === "GET") {
    return serveMedia(pathname, response);
  }

  return serveStatic(pathname, response);
});

server.listen(PORT, () => {
  console.log(`직원용 사이트: http://localhost:${PORT}`);
  console.log(`관리자용 사이트: http://localhost:${PORT}/admin`);
  console.log(`데이터 경로: ${DATA_DIR}`);
});

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  if (!fs.existsSync(MEDIA_BACKUP_DIR)) {
    fs.mkdirSync(MEDIA_BACKUP_DIR, { recursive: true });
  }

  migrateBundledDataIfNeeded();

  if (!fs.existsSync(VIDEOS_PATH)) {
    writeJson(VIDEOS_PATH, defaultVideos());
  }

  if (!fs.existsSync(VOTES_PATH)) {
    writeJson(VOTES_PATH, []);
  }

  if (!fs.existsSync(STATE_PATH)) {
    writeJson(STATE_PATH, {
      resetVersion: 1,
      updatedAt: new Date().toISOString(),
      votingClosed: false
    });
  }

  if (!fs.existsSync(EMPLOYEES_PATH)) {
    writeJson(EMPLOYEES_PATH, []);
  }

  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
}

function initializeStorage() {
  if (USE_DATABASE_STORAGE) {
    ensureSupportDirectories();
    initializeDatabaseStorage();
    return;
  }

  ensureDataFiles();
}

function ensureSupportDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  if (!fs.existsSync(MEDIA_BACKUP_DIR)) {
    fs.mkdirSync(MEDIA_BACKUP_DIR, { recursive: true });
  }

  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
}

function initializeDatabaseStorage() {
  const loaded = runDatabaseStorageProcess("loadAll");
  const hasStoredData = loaded && Object.keys(loaded).length > 0;
  const initialData = hasStoredData
    ? loaded
    : {
      videos: readBundledJsonOrDefault(VIDEOS_PATH, defaultVideos()),
      votes: readBundledJsonOrDefault(VOTES_PATH, []),
      state: readBundledJsonOrDefault(STATE_PATH, {
        resetVersion: 1,
        updatedAt: new Date().toISOString(),
        votingClosed: false
      }),
      employees: readBundledJsonOrDefault(EMPLOYEES_PATH, [])
    };

  databaseState.cache.videos = cloneJson(initialData.videos || defaultVideos());
  databaseState.cache.votes = cloneJson(initialData.votes || []);
  databaseState.cache.state = cloneJson(initialData.state || {
    resetVersion: 1,
    updatedAt: new Date().toISOString(),
    votingClosed: false
  });
  databaseState.cache.employees = cloneJson(initialData.employees || []);

  if (!hasStoredData) {
    persistDatabasePayload("videos", databaseState.cache.videos);
    persistDatabasePayload("votes", databaseState.cache.votes);
    persistDatabasePayload("state", databaseState.cache.state);
    persistDatabasePayload("employees", databaseState.cache.employees);
  }

  databaseState.initialized = true;
}

function resolveWritableDataDir(preferredPath) {
  const candidates = [preferredPath];

  if (preferredPath !== DEFAULT_LOCAL_DATA_DIR) {
    candidates.push(DEFAULT_LOCAL_DATA_DIR);
  }

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);

      if (candidate !== preferredPath) {
        console.warn(`기본 데이터 경로를 사용할 수 없어 로컬 경로로 전환합니다: ${preferredPath} -> ${candidate}`);
      }

      return candidate;
    } catch (error) {
      console.warn(`데이터 경로 준비 실패: ${candidate}`, error.code || error.message);
    }
  }

  throw new Error(`사용 가능한 데이터 경로를 준비하지 못했습니다. preferred=${preferredPath}`);
}

function defaultVideos() {
  return [
    {
      id: "vision-story",
      title: "01. AI로 바꿔보는 우리의 하루",
      submitter: "김선빈",
      description: "AI를 활용한 사내 업무 변화를 소개하는 출품작입니다.",
      type: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    },
    {
      id: "work-smarter",
      title: "02. 더 빠르게, 더 똑똑하게",
      submitter: "이재미",
      description: "AI 기반 업무 혁신 아이디어를 소개하는 출품작입니다.",
      type: "youtube",
      url: "https://www.youtube.com/watch?v=LgRp9isEuSo"
    }
  ];
}

function migrateBundledDataIfNeeded() {
  const bundledDataDir = DEFAULT_LOCAL_DATA_DIR;
  const bundledVideosPath = path.join(bundledDataDir, "videos.json");
  const bundledVotesPath = path.join(bundledDataDir, "votes.json");
  const bundledStatePath = path.join(bundledDataDir, "state.json");
  const bundledEmployeesPath = path.join(bundledDataDir, "employees.json");

  if (DATA_DIR === bundledDataDir) {
    return;
  }

  if (!fs.existsSync(VIDEOS_PATH) && fs.existsSync(bundledVideosPath)) {
    fs.copyFileSync(bundledVideosPath, VIDEOS_PATH);
  }

  if (!fs.existsSync(VOTES_PATH) && fs.existsSync(bundledVotesPath)) {
    fs.copyFileSync(bundledVotesPath, VOTES_PATH);
  }

  if (!fs.existsSync(STATE_PATH) && fs.existsSync(bundledStatePath)) {
    fs.copyFileSync(bundledStatePath, STATE_PATH);
  }

  if (!fs.existsSync(EMPLOYEES_PATH) && fs.existsSync(bundledEmployeesPath)) {
    fs.copyFileSync(bundledEmployeesPath, EMPLOYEES_PATH);
  }
}

function readBundledJsonOrDefault(filePath, fallbackValue) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch {}

  return cloneJson(fallbackValue);
}

function handleEligibleVoterLookup(response, searchParams) {
  const employeeNumber = sanitizeText(searchParams.get("employeeNumber"));
  const password = sanitizeText(searchParams.get("password"));

  if (!employeeNumber || !password) {
    return sendJson(response, 400, { message: "사원번호와 비밀번호를 입력해 주세요." });
  }

  const employee = findEmployee(employeeNumber);
  if (!employee || employee.password !== password) {
    return sendJson(response, 401, { message: "사원번호 또는 비밀번호를 다시 확인해 주세요." });
  }

  const vote = findVote(employeeNumber);
  return sendJson(response, 200, {
    employeeNumber,
    voterName: employee.voterName,
    hasVoted: Boolean(vote),
    videoIds: vote ? normalizeVoteVideoIds(vote) : [],
    submittedAt: vote ? vote.submittedAt : null
  });
}

function buildResults() {
  const videos = readJson(VIDEOS_PATH);
  const votes = readJson(VOTES_PATH);
  const employees = readJson(EMPLOYEES_PATH);
  const voteCounts = videos.reduce((accumulator, video) => {
    accumulator[video.id] = 0;
    return accumulator;
  }, {});

  let totalSelections = 0;

  votes.forEach((vote) => {
    for (const videoId of normalizeVoteVideoIds(vote)) {
      if (voteCounts[videoId] !== undefined) {
        voteCounts[videoId] += 1;
        totalSelections += 1;
      }
    }
  });

  return {
    totalVoters: votes.length,
    totalEligible: employees.length,
    totalSelections,
    voteCounts
  };
}

async function handleVote(request, response) {
  try {
    const payload = JSON.parse((await readRequestBody(request)) || "{}");
    const employeeNumber = sanitizeText(payload.employeeNumber);
    const password = sanitizeText(payload.password);
    const videoIds = Array.isArray(payload.videoIds)
      ? [...new Set(payload.videoIds.map((value) => sanitizeText(value)).filter(Boolean))]
      : [];
    const state = readJson(STATE_PATH);
    const videos = readJson(VIDEOS_PATH);
    const votes = readJson(VOTES_PATH);
    const employee = findEmployee(employeeNumber);

    if (!employeeNumber || !password) {
      return sendJson(response, 400, { message: "사원번호와 비밀번호를 입력해 주세요." });
    }

    if (videoIds.length !== 1) {
      return sendJson(response, 400, { message: "반드시 작품 1개를 선택해 주세요." });
    }

    if (!employee || employee.password !== password) {
      return sendJson(response, 403, { message: "사원번호 또는 비밀번호를 다시 확인해 주세요." });
    }

    if (state.votingClosed) {
      return sendJson(response, 403, { message: "투표가 마감되어 더 이상 참여할 수 없습니다." });
    }

    if (!videoIds.every((videoId) => videos.some((video) => video.id === videoId))) {
      return sendJson(response, 400, { message: "선택한 작품 정보가 올바르지 않습니다." });
    }

    if (votes.some((vote) => vote.employeeNumber === employeeNumber)) {
      return sendJson(response, 409, { message: "최초 제출 후에는 내용을 변경하거나 다시 투표할 수 없습니다." });
    }

    const newVote = {
      employeeNumber,
      voterName: employee.voterName,
      videoIds,
      submittedAt: new Date().toISOString()
    };

    votes.push(newVote);
    writeJson(VOTES_PATH, votes);

    return sendJson(response, 201, {
      message: "투표가 저장되었습니다.",
      voterName: newVote.voterName,
      submittedAt: newVote.submittedAt
    });
  } catch (error) {
    return sendJson(response, 500, { message: "서버에서 투표를 처리하지 못했습니다." });
  }
}

async function handleVideoCreate(request, response) {
  try {
    const videos = readJson(VIDEOS_PATH);
    const payload = normalizeVideoPayload(JSON.parse((await readRequestBody(request)) || "{}"));

    if (!payload) {
      return sendJson(response, 400, { message: "영상 정보를 모두 올바르게 입력해 주세요." });
    }

    const video = { id: createVideoId(payload.title, videos), ...payload, localVideoUrl: "" };
    videos.push(video);
    writeJson(VIDEOS_PATH, videos);
    return sendJson(response, 201, { message: "영상이 등록되었습니다.", video });
  } catch (error) {
    return sendJson(response, 500, { message: "영상 등록에 실패했습니다." });
  }
}

async function handleVideoUpdate(request, response, id) {
  try {
    const videos = readJson(VIDEOS_PATH);
    const payload = normalizeVideoPayload(JSON.parse((await readRequestBody(request)) || "{}"));

    if (!payload) {
      return sendJson(response, 400, { message: "영상 정보를 모두 올바르게 입력해 주세요." });
    }

    const index = videos.findIndex((video) => video.id === id);
    if (index < 0) {
      return sendJson(response, 404, { message: "수정할 영상을 찾지 못했습니다." });
    }

    videos[index] = { ...videos[index], id, ...payload };
    writeJson(VIDEOS_PATH, videos);
    return sendJson(response, 200, { message: "영상이 수정되었습니다.", video: videos[index] });
  } catch (error) {
    return sendJson(response, 500, { message: "영상 수정에 실패했습니다." });
  }
}

function handleVideoUpload(request, response, id) {
  const videos = readJson(VIDEOS_PATH);
  const index = videos.findIndex((video) => video.id === id);

  if (index < 0) {
    return sendJson(response, 404, { message: "업로드할 영상을 찾지 못했습니다." });
  }

  const busboy = Busboy({ headers: request.headers });
  let savedFileName = "";
  let uploadError = null;
  let hasFile = false;

  busboy.on("file", (fieldName, file, info) => {
    if (fieldName !== "videoFile") {
      file.resume();
      return;
    }

    hasFile = true;
    const extension = path.extname(info.filename || "").toLowerCase() || ".mp4";
    if (extension !== ".mp4") {
      uploadError = "MP4 파일만 업로드할 수 있습니다.";
      file.resume();
      return;
    }

    const nextFileName = `${id}-${Date.now()}${extension}`;
    const destinationPath = path.join(MEDIA_DIR, nextFileName);
    const writeStream = fs.createWriteStream(destinationPath);

    file.pipe(writeStream);
    savedFileName = nextFileName;

    writeStream.on("error", () => {
      uploadError = "영상 파일 저장에 실패했습니다.";
    });
  });

  busboy.on("finish", () => {
    if (uploadError) {
      if (savedFileName) {
        safelyDeleteFile(path.join(MEDIA_DIR, savedFileName));
      }
      return sendJson(response, 400, { message: uploadError });
    }

    if (!hasFile || !savedFileName) {
      return sendJson(response, 400, { message: "업로드할 MP4 파일을 선택해 주세요." });
    }

    const previousUrl = videos[index].localVideoUrl;
    videos[index].localVideoUrl = `/media/${savedFileName}`;
    writeJson(VIDEOS_PATH, videos);

    if (previousUrl) {
      backupMediaFile(path.join(MEDIA_DIR, path.basename(previousUrl)));
      safelyDeleteFile(path.join(MEDIA_DIR, path.basename(previousUrl)));
    }

    return sendJson(response, 200, {
      message: "사이트 재생용 영상 파일이 업로드되었습니다.",
      localVideoUrl: videos[index].localVideoUrl
    });
  });

  request.pipe(busboy);
}

function handleVideoDelete(response, id) {
  const videos = readJson(VIDEOS_PATH);
  const votes = readJson(VOTES_PATH);
  const target = videos.find((video) => video.id === id);
  const nextVideos = videos.filter((video) => video.id !== id);

  if (nextVideos.length === videos.length) {
    return sendJson(response, 404, { message: "삭제할 영상을 찾지 못했습니다." });
  }

  writeJson(VIDEOS_PATH, nextVideos);
  writeJson(
    VOTES_PATH,
    votes
      .map((vote) => ({
        ...vote,
        videoIds: normalizeVoteVideoIds(vote).filter((videoId) => videoId !== id)
      }))
      .filter((vote) => vote.videoIds.length > 0)
  );

  if (target?.localVideoUrl) {
    backupMediaFile(path.join(MEDIA_DIR, path.basename(target.localVideoUrl)));
    safelyDeleteFile(path.join(MEDIA_DIR, path.basename(target.localVideoUrl)));
  }
  return sendJson(response, 200, { message: "영상과 관련 투표가 삭제되었습니다." });
}

function handleVoteDelete(response, employeeNumber) {
  const votes = readJson(VOTES_PATH);
  const nextVotes = votes.filter((vote) => vote.employeeNumber !== employeeNumber);

  if (nextVotes.length === votes.length) {
    return sendJson(response, 404, { message: "삭제할 투표를 찾지 못했습니다." });
  }

  writeJson(VOTES_PATH, nextVotes);
  return sendJson(response, 200, { message: "개별 투표가 삭제되었습니다." });
}

function handleExportResults(response) {
  const videos = readJson(VIDEOS_PATH);
  const votes = readJson(VOTES_PATH);
  const employees = readJson(EMPLOYEES_PATH);
  const results = buildResults();

  const summaryRows = [
    ["구분", "값"],
    ["총 대상 인원", results.totalEligible],
    ["투표 완료 인원", results.totalVoters],
    ["총 선택 수", results.totalSelections],
    [],
    ["등수", "영상 번호", "작품명", "득표 수", "득표율(%)"]
  ];

  const rankedVideos = videos
    .map((video, index) => {
      const count = results.voteCounts[video.id] || 0;
      const percentage = results.totalSelections > 0 ? Number(((count / results.totalSelections) * 100).toFixed(2)) : 0;
      return {
        video,
        originalIndex: index,
        count,
        percentage
      };
    })
    .sort((left, right) => right.count - left.count || left.originalIndex - right.originalIndex);

  let previousCount = null;
  let currentRank = 0;

  rankedVideos.forEach((item, index) => {
    if (item.count !== previousCount) {
      currentRank = index + 1;
      previousCount = item.count;
    }

    summaryRows.push([
      currentRank,
      String(item.originalIndex + 1).padStart(2, "0"),
      stripLeadingNumber(item.video.title),
      item.count,
      item.percentage
    ]);
  });

  const voteRows = [
    ["사원번호", "이름", "선택 1", "제출 시각"]
  ];
  const videoNumberById = new Map(
    videos.map((video, index) => [video.id, String(index + 1).padStart(2, "0")])
  );

  votes.forEach((vote) => {
    const selectedNumbers = normalizeVoteVideoIds(vote).map((videoId) => {
      return videoNumberById.get(videoId) || videoId;
    });

    voteRows.push([
      vote.employeeNumber,
      vote.voterName,
      selectedNumbers[0] || "",
      vote.submittedAt
    ]);
  });

  const pendingRows = [["사원번호", "이름", "상태"]];
  const votedEmployeeNumbers = new Set(votes.map((vote) => vote.employeeNumber));
  employees
    .filter((employee) => !votedEmployeeNumbers.has(employee.employeeNumber))
    .forEach((employee) => {
      pendingRows.push([employee.employeeNumber, employee.voterName, "투표 바랍니다"]);
    });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "결과 요약");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(voteRows), "투표 내역");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(pendingRows), "미투표 현황");

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx"
  });

  response.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${encodeURIComponent("2026-ai-video-awards-results.xlsx")}"`
  });
  response.end(buffer);
}

function handleVideoImportTemplate(response) {
  const rows = [
    ["영상 제목", "제출자", "내용", "영상 링크"],
    ["01. 샘플 영상", "홍길동", "영상 설명을 입력합니다.", "https://www.youtube.com/watch?v=example"]
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "영상등록양식");

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx"
  });

  response.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${encodeURIComponent("2026-ai-video-import-template.xlsx")}"`
  });
  response.end(buffer);
}

function handleEmployeeImportTemplate(response) {
  const rows = [
    ["사원번호", "이름", "비밀번호 (휴대폰 뒷자리)"],
    ["180012", "김선빈", "1234"]
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "직원명단양식");

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx"
  });

  response.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${encodeURIComponent("2026-ai-employee-import-template.xlsx")}"`
  });
  response.end(buffer);
}

function handleVideoImport(request, response) {
  const busboy = Busboy({ headers: request.headers });
  const chunks = [];
  let hasFile = false;
  let uploadError = null;

  busboy.on("file", (fieldName, file, info) => {
    if (fieldName !== "videoSheet") {
      file.resume();
      return;
    }

    hasFile = true;
    const extension = path.extname(info.filename || "").toLowerCase();
    if (![".xlsx", ".xls"].includes(extension)) {
      uploadError = "엑셀 파일(.xlsx, .xls)만 업로드할 수 있습니다.";
      file.resume();
      return;
    }

    file.on("data", (chunk) => chunks.push(chunk));
  });

  busboy.on("finish", () => {
    if (uploadError) {
      return sendJson(response, 400, { message: uploadError });
    }

    if (!hasFile || !chunks.length) {
      return sendJson(response, 400, { message: "업로드할 엑셀 파일을 선택해 주세요." });
    }

    try {
      const workbook = XLSX.read(Buffer.concat(chunks), { type: "buffer" });
      const firstSheetName = workbook.SheetNames[0];
      const firstSheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

      if (!rows.length) {
        return sendJson(response, 400, { message: "엑셀 파일에 등록할 영상 정보가 없습니다." });
      }

      const importedVideos = [];

      for (const row of rows) {
        const payload = normalizeVideoPayload({
          title: row["영상 제목"] || row.title || row["제목"],
          submitter: row["제출자"] || row.submitter,
          description: row["내용"] || row.description,
          type: "youtube",
          url: row["영상 링크"] || row.url || row["유튜브 링크"]
        });

        if (!payload) {
          continue;
        }

        importedVideos.push({
          id: createVideoId(payload.title, importedVideos),
          ...payload,
          localVideoUrl: ""
        });
      }

      if (!importedVideos.length) {
        return sendJson(response, 400, {
          message: "유효한 행이 없습니다. 열 이름은 영상 제목, 제출자, 내용, 영상 링크로 맞춰주세요."
        });
      }

      const nextVideoIds = new Set(importedVideos.map((video) => video.id));
      const filteredVotes = readJson(VOTES_PATH)
        .map((vote) => ({
          ...vote,
          videoIds: normalizeVoteVideoIds(vote).filter((videoId) => nextVideoIds.has(videoId))
        }))
        .filter((vote) => vote.videoIds.length > 0);

      writeJson(VIDEOS_PATH, importedVideos);
      writeJson(VOTES_PATH, filteredVotes);
      return sendJson(response, 201, {
        message: `${importedVideos.length}개의 영상으로 기존 목록을 덮어썼습니다.`,
        count: importedVideos.length,
        videos: importedVideos
      });
    } catch (error) {
      return sendJson(response, 400, { message: "엑셀 파일을 읽는 중 오류가 발생했습니다." });
    }
  });

  request.pipe(busboy);
}

function handleEmployeeImport(request, response) {
  const busboy = Busboy({ headers: request.headers });
  const chunks = [];
  let hasFile = false;
  let uploadError = null;

  busboy.on("file", (fieldName, file, info) => {
    if (fieldName !== "employeeSheet") {
      file.resume();
      return;
    }

    hasFile = true;
    const extension = path.extname(info.filename || "").toLowerCase();
    if (![".xlsx", ".xls"].includes(extension)) {
      uploadError = "엑셀 파일(.xlsx, .xls)만 업로드할 수 있습니다.";
      file.resume();
      return;
    }

    file.on("data", (chunk) => chunks.push(chunk));
  });

  busboy.on("finish", () => {
    if (uploadError) {
      return sendJson(response, 400, { message: uploadError });
    }

    if (!hasFile || !chunks.length) {
      return sendJson(response, 400, { message: "업로드할 엑셀 파일을 선택해 주세요." });
    }

    try {
      const workbook = XLSX.read(Buffer.concat(chunks), { type: "buffer" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

      if (!rows.length) {
        return sendJson(response, 400, { message: "엑셀 파일에 직원 정보가 없습니다." });
      }

      const importedEmployees = [];

      for (const row of rows) {
        const payload = normalizeEmployeePayload({
          employeeNumber: row["사원번호"] || row.employeeNumber || row["사번"],
          voterName: row["이름"] || row.voterName || row["성명"],
          password:
            row["비밀번호 (휴대폰 뒷자리)"] ||
            row.password ||
            row["비밀번호"] ||
            row["휴대폰 뒷자리"]
        });

        if (!payload) {
          continue;
        }

        if (importedEmployees.some((employee) => employee.employeeNumber === payload.employeeNumber)) {
          continue;
        }

        importedEmployees.push(payload);
      }

      if (!importedEmployees.length) {
        return sendJson(response, 400, {
          message: "유효한 직원 정보가 없습니다. 열 이름을 사원번호, 이름, 비밀번호 (휴대폰 뒷자리)로 맞춰주세요."
        });
      }

      const allowedEmployeeNumbers = new Set(importedEmployees.map((employee) => employee.employeeNumber));
      const filteredVotes = readJson(VOTES_PATH).filter((vote) => allowedEmployeeNumbers.has(vote.employeeNumber));

      writeJson(EMPLOYEES_PATH, importedEmployees);
      writeJson(VOTES_PATH, filteredVotes);

      return sendJson(response, 201, {
        message: `${importedEmployees.length}명의 직원 명단으로 로그인 기준을 덮어썼습니다.`,
        count: importedEmployees.length
      });
    } catch (error) {
      return sendJson(response, 400, { message: "엑셀 파일을 읽는 중 오류가 발생했습니다." });
    }
  });

  request.pipe(busboy);
}

function handleRestoreLatestVideosBackup(response) {
  const backups = listJsonBackups("videos");

  if (!backups.length) {
    return sendJson(response, 404, { message: "복원 가능한 영상 백업이 없습니다." });
  }

  const latestBackup = backups[0];
  const backupPath = path.join(BACKUP_DIR, latestBackup.name);
  const payload = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  writeJson(VIDEOS_PATH, payload);

  return sendJson(response, 200, {
    message: "최신 영상 백업으로 복원되었습니다.",
    restoredBackup: latestBackup.name,
    count: Array.isArray(payload) ? payload.length : 0
  });
}

function normalizeVideoPayload(payload) {
  const title = sanitizeText(payload.title);
  const submitter = sanitizeText(payload.submitter);
  const description = sanitizeText(payload.description);
  const type = sanitizeText(payload.type || "youtube");
  const url = sanitizeText(payload.url);

  if (!title || !submitter || !description || !url || type !== "youtube") {
    return null;
  }

  return { title, submitter, description, type, url };
}

function normalizeEmployeePayload(payload) {
  const employeeNumber = sanitizeText(payload.employeeNumber);
  const voterName = sanitizeText(payload.voterName);
  const password = sanitizeText(payload.password);

  if (!employeeNumber || !voterName || !password || !/^\d{4}$/.test(password)) {
    return null;
  }

  return { employeeNumber, voterName, password };
}

function createVideoId(title, videos) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "") || "video";

  let candidate = base;
  let suffix = 1;
  while (videos.some((video) => video.id === candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  return candidate;
}

function serveStatic(pathname, response) {
  const safePath =
    pathname === "/" ? "/index.html" :
    pathname === "/admin" ? "/admin.html" :
    pathname;
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(content);
  });
}

function serveMedia(pathname, response) {
  const fileName = pathname.replace(/^\/media\//, "");
  const filePath = path.join(MEDIA_DIR, fileName);

  if (!filePath.startsWith(MEDIA_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Accept-Ranges": "bytes"
    });
    response.end(content);
  });
}

function normalizeVoteVideoIds(vote) {
  if (Array.isArray(vote.videoIds)) {
    return vote.videoIds;
  }

  if (vote.videoId) {
    return [vote.videoId];
  }

  return [];
}

function findEmployee(employeeNumber) {
  const employees = readJson(EMPLOYEES_PATH);
  return employees.find((employee) => employee.employeeNumber === employeeNumber) || null;
}

function findVote(employeeNumber) {
  const votes = readJson(VOTES_PATH);
  return votes.find((vote) => vote.employeeNumber === employeeNumber) || null;
}

function isAuthorizedAdmin(request) {
  return request.headers["x-admin-password"] === ADMIN_PASSWORD;
}

function readJson(filePath) {
  if (USE_DATABASE_STORAGE) {
    const storageKey = STORAGE_KEY_BY_PATH.get(filePath);
    if (!storageKey) {
      throw new Error(`Unsupported storage path in database mode: ${filePath}`);
    }
    return cloneJson(databaseState.cache[storageKey]);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  if (USE_DATABASE_STORAGE) {
    const storageKey = STORAGE_KEY_BY_PATH.get(filePath);
    if (!storageKey) {
      throw new Error(`Unsupported storage path in database mode: ${filePath}`);
    }

    const nextPayload = cloneJson(payload);
    databaseState.cache[storageKey] = nextPayload;
    persistDatabasePayload(storageKey, nextPayload);
    return;
  }

  const nextContent = JSON.stringify(payload, null, 2);
  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";

  if (currentContent === nextContent) {
    return;
  }

  if (currentContent) {
    createJsonBackup(filePath, currentContent);
  }

  fs.writeFileSync(filePath, nextContent, "utf8");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sanitizeText(value) {
  return String(value || "").trim();
}

function stripLeadingNumber(title) {
  return String(title || "").replace(/^\d+\.\s*/, "");
}

function safelyDeleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function createJsonBackup(filePath, content) {
  if (USE_DATABASE_STORAGE) {
    return;
  }

  try {
    const baseName = path.basename(filePath, path.extname(filePath));
    const stamp = createBackupStamp();
    const versionedPath = path.join(BACKUP_DIR, `${baseName}-${stamp}.json`);
    const latestPath = path.join(BACKUP_DIR, `${baseName}-latest.json`);

    fs.writeFileSync(versionedPath, content, "utf8");
    fs.writeFileSync(latestPath, content, "utf8");
    pruneBackups(BACKUP_DIR, `${baseName}-`, ".json", JSON_BACKUP_RETENTION, [`${baseName}-latest.json`]);
  } catch {}
}

function listJsonBackups(baseName) {
  if (USE_DATABASE_STORAGE) {
    return [];
  }

  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((name) => name.startsWith(`${baseName}-`) && name.endsWith(".json") && name !== `${baseName}-latest.json`)
      .map((name) => {
        const fullPath = path.join(BACKUP_DIR, name);
        const stat = fs.statSync(fullPath);
        return {
          name,
          size: stat.size,
          updatedAt: stat.mtime.toISOString()
        };
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

function backupMediaFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const extension = path.extname(filePath);
    const baseName = path.basename(filePath, extension);
    const stamp = createBackupStamp();
    const backupPath = path.join(MEDIA_BACKUP_DIR, `${baseName}-${stamp}${extension}`);
    fs.copyFileSync(filePath, backupPath);
    pruneBackups(MEDIA_BACKUP_DIR, `${baseName}-`, extension, MEDIA_BACKUP_RETENTION);
  } catch {}
}

function pruneBackups(directoryPath, prefix, extension, retention, keepNames = []) {
  try {
    const files = fs.readdirSync(directoryPath)
      .filter((name) => name.startsWith(prefix) && name.endsWith(extension) && !keepNames.includes(name))
      .map((name) => ({
        name,
        fullPath: path.join(directoryPath, name),
        mtimeMs: fs.statSync(path.join(directoryPath, name)).mtimeMs
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    files.slice(retention).forEach((file) => {
      safelyDeleteFile(file.fullPath);
    });
  } catch {}
}

function createBackupStamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function getStorageStatus() {
  return {
    storageMode: USE_DATABASE_STORAGE ? "database" : "json",
    requestedDataDir: REQUESTED_DATA_DIR,
    dataDir: DATA_DIR,
    usingFallbackDataDir: USING_FALLBACK_DATA_DIR,
    usingRenderDiskPath: DATA_DIR === DEFAULT_RENDER_DATA_DIR,
    persistentReady: USE_DATABASE_STORAGE || !REQUIRE_PERSISTENT_DATA || !USING_FALLBACK_DATA_DIR,
    databaseStorageEnabled: USE_DATABASE_STORAGE,
    databaseInitialized: USE_DATABASE_STORAGE ? databaseState.initialized : false,
    videosExists: fs.existsSync(VIDEOS_PATH),
    votesExists: fs.existsSync(VOTES_PATH),
    stateExists: fs.existsSync(STATE_PATH),
    employeesExists: fs.existsSync(EMPLOYEES_PATH),
    mediaDirExists: fs.existsSync(MEDIA_DIR),
    backupDirExists: fs.existsSync(BACKUP_DIR)
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function persistDatabasePayload(storageKey, payload) {
  runDatabaseStorageProcess("save", {
    storageKey,
    value: payload
  });
}

function runDatabaseStorageProcess(operation, payload = {}) {
  const helperScript = `
    const { Client } = require("pg");

    function shouldUseSsl(connectionString) {
      const explicitSsl = String(process.env.DATABASE_SSL || "").toLowerCase();
      const pgSslMode = String(process.env.PGSSLMODE || "").toLowerCase();

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

    async function main() {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error("DATABASE_URL is required");
      }

      const useSsl = shouldUseSsl(connectionString);

      const client = new Client({
        connectionString,
        ssl: useSsl ? { rejectUnauthorized: false } : false
      });

      await client.connect();
      await client.query(
        "create table if not exists app_json_store (" +
        "storage_key text primary key," +
        "value jsonb not null," +
        "updated_at timestamptz not null default now()" +
        ")"
      );

      const operation = process.env.DB_STORAGE_OPERATION;
      if (operation === "loadAll") {
        const result = await client.query("select storage_key, value from app_json_store");
        const payload = {};
        for (const row of result.rows) {
          payload[row.storage_key] = row.value;
        }
        process.stdout.write(JSON.stringify(payload));
      } else if (operation === "save") {
        const storageKey = process.env.DB_STORAGE_KEY;
        const value = JSON.parse(process.env.DB_STORAGE_VALUE || "null");
        await client.query(
          "insert into app_json_store (storage_key, value, updated_at) values ($1, $2::jsonb, now()) " +
          "on conflict (storage_key) do update set value = excluded.value, updated_at = now()",
          [storageKey, JSON.stringify(value)]
        );
        process.stdout.write("{\\"ok\\":true}");
      } else {
        throw new Error("Unsupported DB storage operation");
      }

      await client.end();
    }

    main().catch(async (error) => {
      try {}
      finally {
        console.error(error && error.stack ? error.stack : String(error));
        process.exit(1);
      }
    });
  `;

  const env = {
    ...process.env,
    DB_STORAGE_OPERATION: operation
  };

  if (payload.storageKey) {
    env.DB_STORAGE_KEY = payload.storageKey;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "value")) {
    env.DB_STORAGE_VALUE = JSON.stringify(payload.value);
  }

  const output = execFileSync(process.execPath, ["-e", helperScript], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return output ? JSON.parse(output) : null;
}
