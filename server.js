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
const CONTEST_TYPES = [
  { id: "video", label: "영상 콘테스트" },
  { id: "bgm", label: "AI Music Contest" }
];
const DEFAULT_CONTEST_TYPE = "video";
const CONTEST_TYPE_IDS = new Set(CONTEST_TYPES.map((contestType) => contestType.id));
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
  ".aac": "audio/aac",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".wav": "audio/wav"
};

STORAGE_KEY_BY_PATH.set(VIDEOS_PATH, "videos");
STORAGE_KEY_BY_PATH.set(VOTES_PATH, "votes");
STORAGE_KEY_BY_PATH.set(STATE_PATH, "state");
STORAGE_KEY_BY_PATH.set(EMPLOYEES_PATH, "employees");

function getContestTypes() {
  return CONTEST_TYPES.map((contestType) => ({ ...contestType }));
}

function buildDefaultVotingClosedState() {
  return CONTEST_TYPES.reduce((accumulator, contestType) => {
    accumulator[contestType.id] = false;
    return accumulator;
  }, {});
}

function normalizeContestType(value) {
  const normalized = sanitizeText(value).toLowerCase();
  return CONTEST_TYPE_IDS.has(normalized) ? normalized : DEFAULT_CONTEST_TYPE;
}

function getContestLabel(contestType) {
  const normalized = normalizeContestType(contestType);
  return CONTEST_TYPES.find((item) => item.id === normalized)?.label || CONTEST_TYPES[0].label;
}

function normalizeStatePayload(payload) {
  const state = payload && typeof payload === "object" ? payload : {};
  const legacyVotingClosed = Boolean(state.votingClosed);
  const votingClosedByContestType = buildDefaultVotingClosedState();
  const publicContestType = normalizeContestType(state.publicContestType);

  for (const contestType of CONTEST_TYPES) {
    const storedValue = state.votingClosedByContestType?.[contestType.id];
    votingClosedByContestType[contestType.id] = typeof storedValue === "boolean" ? storedValue : legacyVotingClosed;
  }

  return {
    ...state,
    resetVersion: Number.isFinite(Number(state.resetVersion)) ? Number(state.resetVersion) : 1,
    updatedAt: sanitizeText(state.updatedAt) || new Date().toISOString(),
    publicContestType,
    votingClosedByContestType,
    votingClosed: votingClosedByContestType[DEFAULT_CONTEST_TYPE]
  };
}

function isVotingClosedForContest(state, contestType) {
  const normalizedState = normalizeStatePayload(state);
  return Boolean(normalizedState.votingClosedByContestType[normalizeContestType(contestType)]);
}

function normalizeVideoRecord(video) {
  const contestType = normalizeContestType(video.contestType);
  return {
    ...video,
    id: sanitizeText(video.id),
    title: sanitizeText(video.title),
    submitter: sanitizeText(video.submitter),
    description: sanitizeText(video.description),
    lyrics: sanitizeText(video.lyrics),
    contestType,
    type: contestType === "bgm" ? "audio" : "youtube",
    url: sanitizeText(video.url),
    localVideoUrl: sanitizeText(video.localVideoUrl)
  };
}

function normalizeVideosPayload(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((video) => normalizeVideoRecord(video || {}))
    .filter((video) => {
      if (!video.id || !video.title || !video.submitter || !video.description) {
        return false;
      }

      if (video.contestType === "video") {
        return Boolean(video.url);
      }

      return Boolean(video.localVideoUrl || video.url || video.contestType === "bgm");
    });
}

function normalizeVoteRecord(vote) {
  const videoIds = [...new Set(normalizeVoteVideoIds(vote).map((value) => sanitizeText(value)).filter(Boolean))];

  return {
    ...vote,
    employeeNumber: sanitizeText(vote.employeeNumber),
    voterName: sanitizeText(vote.voterName),
    contestType: normalizeContestType(vote.contestType),
    videoIds,
    submittedAt: sanitizeText(vote.submittedAt) || new Date().toISOString()
  };
}

function normalizeVotesPayload(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((vote) => normalizeVoteRecord(vote || {}))
    .filter((vote) => vote.employeeNumber && vote.videoIds.length > 0);
}

function normalizeEmployeesPayload(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((employee) => normalizeEmployeePayload(employee || {}))
    .filter(Boolean);
}

function normalizeStoragePayload(filePath, payload) {
  if (filePath === VIDEOS_PATH) {
    return normalizeVideosPayload(payload);
  }

  if (filePath === VOTES_PATH) {
    return normalizeVotesPayload(payload);
  }

  if (filePath === STATE_PATH) {
    return normalizeStatePayload(payload);
  }

  if (filePath === EMPLOYEES_PATH) {
    return normalizeEmployeesPayload(payload);
  }

  return payload;
}

function buildResultsByContestType() {
  return Object.fromEntries(CONTEST_TYPES.map((contestType) => [contestType.id, buildResults(contestType.id)]));
}

initializeStorage();

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === "/api/videos" && request.method === "GET") {
    return sendJson(response, 200, readJson(VIDEOS_PATH));
  }

  if (pathname === "/api/meta" && request.method === "GET") {
    const contestType = normalizeContestType(requestUrl.searchParams.get("contestType"));
    const state = readJson(STATE_PATH);
    return sendJson(response, 200, {
      ...state,
      activeContestType: contestType,
      publicContestType: state.publicContestType,
      contestTypes: getContestTypes(),
      votingClosed: isVotingClosedForContest(state, contestType)
    });
  }

  if (pathname === "/api/results" && request.method === "GET") {
    const contestType = requestUrl.searchParams.has("contestType")
      ? normalizeContestType(requestUrl.searchParams.get("contestType"))
      : "";
    return sendJson(response, 200, contestType ? buildResults(contestType) : buildResultsByContestType());
  }

  if (pathname === "/api/eligible-voter" && request.method === "GET") {
    return handleEligibleVoterLookup(response, {
      employeeNumber: requestUrl.searchParams.get("employeeNumber"),
      password: requestUrl.searchParams.get("password"),
      contestType: requestUrl.searchParams.get("contestType")
    });
  }

  if (pathname === "/api/eligible-voter" && request.method === "POST") {
    return handleEligibleVoterLookupRequest(request, response);
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
      resultsByContestType: buildResultsByContestType(),
      meta: {
        ...readJson(STATE_PATH),
        contestTypes: getContestTypes()
      }
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
    return handleContestMediaUpload(request, response, videoId);
  }

  if (pathname.startsWith("/api/admin/votes/") && request.method === "DELETE") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleVoteDelete(response, pathname.split("/").pop(), requestUrl.searchParams.get("contestType"));
  }

  if (pathname === "/api/admin/reset-votes" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "??? ????? ???? ????." });
    }

    const contestType = normalizeContestType(requestUrl.searchParams.get("contestType"));
    const state = readJson(STATE_PATH);
    writeJson(VOTES_PATH, readJson(VOTES_PATH).filter((vote) => vote.contestType !== contestType));
    writeJson(STATE_PATH, {
      ...state,
      resetVersion: (state.resetVersion || 0) + 1,
      updatedAt: new Date().toISOString()
    });
    return sendJson(response, 200, { message: `${getContestLabel(contestType)} ??? ????????.` });
  }

  if (pathname === "/api/admin/close-voting" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "??? ????? ???? ????." });
    }

    const contestType = normalizeContestType(requestUrl.searchParams.get("contestType"));
    const state = readJson(STATE_PATH);
    writeJson(STATE_PATH, {
      ...state,
      votingClosedByContestType: {
        ...state.votingClosedByContestType,
        [contestType]: true
      },
      updatedAt: new Date().toISOString()
    });
    return sendJson(response, 200, { message: `${getContestLabel(contestType)} ??? ??????.` });
  }

  if (pathname === "/api/admin/open-voting" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "??? ????? ???? ????." });
    }

    const contestType = normalizeContestType(requestUrl.searchParams.get("contestType"));
    const state = readJson(STATE_PATH);
    writeJson(STATE_PATH, {
      ...state,
      votingClosedByContestType: {
        ...state.votingClosedByContestType,
        [contestType]: false
      },
      updatedAt: new Date().toISOString()
    });
    return sendJson(response, 200, { message: `${getContestLabel(contestType)} ?? ??? ??????.` });
  }

  if (pathname === "/api/admin/export-results" && request.method === "GET") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handleExportResults(response, normalizeContestType(requestUrl.searchParams.get("contestType")));
  }

  if (pathname === "/api/admin/public-contest" && request.method === "POST") {
    if (!isAuthorizedAdmin(request)) {
      return sendJson(response, 401, { message: "관리자 비밀번호가 올바르지 않습니다." });
    }

    return handlePublicContestUpdate(request, response);
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
      publicContestType: DEFAULT_CONTEST_TYPE,
      votingClosed: false,
      votingClosedByContestType: buildDefaultVotingClosedState()
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
        publicContestType: DEFAULT_CONTEST_TYPE,
        votingClosed: false,
        votingClosedByContestType: buildDefaultVotingClosedState()
      }),
      employees: readBundledJsonOrDefault(EMPLOYEES_PATH, [])
    };

  databaseState.cache.videos = cloneJson(initialData.videos || defaultVideos());
  databaseState.cache.votes = cloneJson(initialData.votes || []);
  databaseState.cache.state = cloneJson(initialData.state || {
    resetVersion: 1,
    updatedAt: new Date().toISOString(),
    publicContestType: DEFAULT_CONTEST_TYPE,
    votingClosed: false,
    votingClosedByContestType: buildDefaultVotingClosedState()
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

async function handleEligibleVoterLookupRequest(request, response) {
  try {
    const payload = JSON.parse((await readRequestBody(request)) || "{}");
    return handleEligibleVoterLookup(response, payload);
  } catch {
    return sendJson(response, 400, { message: "잘못된 요청입니다." });
  }
}

function handleEligibleVoterLookup(response, payload) {
  const employeeNumber = sanitizeText(payload.employeeNumber);
  const password = sanitizeText(payload.password);
  const contestType = normalizeContestType(payload.contestType);

  if (!employeeNumber || !password) {
    return sendJson(response, 400, { message: "????? ????? ??? ???." });
  }

  const employee = findEmployee(employeeNumber);
  if (!employee || employee.password !== password) {
    return sendJson(response, 401, { message: "???? ?? ????? ?? ??? ???." });
  }

  const votesByContestType = Object.fromEntries(CONTEST_TYPES.map((item) => {
    const vote = findVote(employeeNumber, item.id);
    return [
      item.id,
      {
        hasVoted: Boolean(vote),
        videoIds: vote ? normalizeVoteVideoIds(vote) : [],
        submittedAt: vote ? vote.submittedAt : null
      }
    ];
  }));

  return sendJson(response, 200, {
    employeeNumber,
    voterName: employee.voterName,
    contestType,
    hasVoted: votesByContestType[contestType].hasVoted,
    videoIds: votesByContestType[contestType].videoIds,
    submittedAt: votesByContestType[contestType].submittedAt,
    votesByContestType
  });
}

function buildResults(contestType = "") {
  const videos = readJson(VIDEOS_PATH);
  const votes = readJson(VOTES_PATH);
  const employees = readJson(EMPLOYEES_PATH);
  const normalizedContestType = contestType ? normalizeContestType(contestType) : "";
  const filteredVideos = normalizedContestType
    ? videos.filter((video) => video.contestType === normalizedContestType)
    : videos;
  const filteredVotes = normalizedContestType
    ? votes.filter((vote) => vote.contestType === normalizedContestType)
    : votes;
  const voteCounts = filteredVideos.reduce((accumulator, video) => {
    accumulator[video.id] = 0;
    return accumulator;
  }, {});

  let totalSelections = 0;

  filteredVotes.forEach((vote) => {
    for (const videoId of normalizeVoteVideoIds(vote)) {
      if (voteCounts[videoId] !== undefined) {
        voteCounts[videoId] += 1;
        totalSelections += 1;
      }
    }
  });

  return {
    contestType: normalizedContestType || null,
    totalVoters: filteredVotes.length,
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
    const contestType = normalizeContestType(payload.contestType);
    const videoIds = Array.isArray(payload.videoIds)
      ? [...new Set(payload.videoIds.map((value) => sanitizeText(value)).filter(Boolean))]
      : [];
    const state = readJson(STATE_PATH);
    const videos = readJson(VIDEOS_PATH);
    const contestVideos = videos.filter((video) => video.contestType === contestType);
    const votes = readJson(VOTES_PATH);
    const employee = findEmployee(employeeNumber);

    if (!employeeNumber || !password) {
      return sendJson(response, 400, { message: "????? ????? ??? ???." });
    }

    if (videoIds.length !== 1) {
      return sendJson(response, 400, { message: "??? ?? 1?? ??? ???." });
    }

    if (!employee || employee.password !== password) {
      return sendJson(response, 403, { message: "???? ?? ????? ?? ??? ???." });
    }

    if (isVotingClosedForContest(state, contestType)) {
      return sendJson(response, 403, { message: "??? ???? ? ?? ??? ? ????." });
    }

    if (!videoIds.every((videoId) => contestVideos.some((video) => video.id === videoId))) {
      return sendJson(response, 400, { message: "??? ?? ??? ???? ????." });
    }

    if (votes.some((vote) => vote.employeeNumber === employeeNumber && vote.contestType === contestType)) {
      return sendJson(response, 409, { message: "?? ????? ?? ??? ???????." });
    }

    const newVote = {
      employeeNumber,
      voterName: employee.voterName,
      contestType,
      videoIds,
      submittedAt: new Date().toISOString()
    };

    votes.push(newVote);
    writeJson(VOTES_PATH, votes);

    return sendJson(response, 201, {
      message: `${getContestLabel(contestType)} ??? ???????.`,
      voterName: newVote.voterName,
      submittedAt: newVote.submittedAt
    });
  } catch (error) {
    return sendJson(response, 500, { message: "???? ??? ???? ?????." });
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
  const contestType = normalizeContestType(videos[index].contestType);
  const allowedExtensions = contestType === "bgm"
    ? new Set([".mp3", ".wav", ".m4a", ".aac"])
    : new Set([".mp4"]);

  busboy.on("file", (fieldName, file, info) => {
    if (fieldName !== "videoFile") {
      file.resume();
      return;
    }

    hasFile = true;
    const extension = path.extname(info.filename || "").toLowerCase() || (contestType === "bgm" ? ".mp3" : ".mp4");
    if (!allowedExtensions.has(extension)) {
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

function handleContestMediaUpload(request, response, id) {
  const videos = readJson(VIDEOS_PATH);
  const index = videos.findIndex((video) => video.id === id);

  if (index < 0) {
    return sendJson(response, 404, { message: "업로드할 작품을 찾지 못했습니다." });
  }

  const contestType = normalizeContestType(videos[index].contestType);
  const allowedExtensions = contestType === "bgm"
    ? new Set([".mp3", ".wav", ".m4a", ".aac"])
    : new Set([".mp4"]);
  const fallbackExtension = contestType === "bgm" ? ".mp3" : ".mp4";
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
    const extension = path.extname(info.filename || "").toLowerCase() || fallbackExtension;
    if (!allowedExtensions.has(extension)) {
      uploadError = contestType === "bgm"
        ? "MP3, WAV, M4A, AAC 음원 파일만 업로드할 수 있습니다."
        : "MP4 파일만 업로드할 수 있습니다.";
      file.resume();
      return;
    }

    const nextFileName = `${id}-${Date.now()}${extension}`;
    const destinationPath = path.join(MEDIA_DIR, nextFileName);
    const writeStream = fs.createWriteStream(destinationPath);

    file.pipe(writeStream);
    savedFileName = nextFileName;

    writeStream.on("error", () => {
      uploadError = contestType === "bgm" ? "음원 파일 저장에 실패했습니다." : "영상 파일 저장에 실패했습니다.";
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
      return sendJson(response, 400, {
        message: contestType === "bgm" ? "업로드할 음원 파일을 선택해 주세요." : "업로드할 MP4 파일을 선택해 주세요."
      });
    }

    const previousUrl = videos[index].localVideoUrl;
    videos[index].localVideoUrl = `/media/${savedFileName}`;
    writeJson(VIDEOS_PATH, videos);

    if (previousUrl) {
      backupMediaFile(path.join(MEDIA_DIR, path.basename(previousUrl)));
      safelyDeleteFile(path.join(MEDIA_DIR, path.basename(previousUrl)));
    }

    return sendJson(response, 200, {
      message: contestType === "bgm" ? "음원 파일이 업로드되었습니다." : "사이트 재생용 영상 파일이 업로드되었습니다.",
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

function handleVoteDelete(response, employeeNumber, contestTypeInput) {
  const contestType = normalizeContestType(contestTypeInput);
  const votes = readJson(VOTES_PATH);
  const nextVotes = votes.filter((vote) => !(vote.employeeNumber === employeeNumber && vote.contestType === contestType));

  if (nextVotes.length === votes.length) {
    return sendJson(response, 404, { message: "??? ??? ?? ?????." });
  }

  writeJson(VOTES_PATH, nextVotes);
  return sendJson(response, 200, { message: `${getContestLabel(contestType)} ??? ??????.` });
}

async function handlePublicContestUpdate(request, response) {
  try {
    const payload = JSON.parse((await readRequestBody(request)) || "{}");
    const publicContestType = normalizeContestType(payload.publicContestType);
    const state = readJson(STATE_PATH);
    writeJson(STATE_PATH, {
      ...state,
      publicContestType,
      updatedAt: new Date().toISOString()
    });

    return sendJson(response, 200, {
      message: `사용자 페이지 노출 콘테스트를 ${getContestLabel(publicContestType)}로 변경했습니다.`,
      publicContestType
    });
  } catch {
    return sendJson(response, 400, { message: "노출 콘테스트 설정을 저장하지 못했습니다." });
  }
}

function handleExportResults(response, contestType) {
  const normalizedContestType = normalizeContestType(contestType);
  const contestLabel = getContestLabel(normalizedContestType);
  const videos = readJson(VIDEOS_PATH).filter((video) => video.contestType === normalizedContestType);
  const votes = readJson(VOTES_PATH).filter((vote) => vote.contestType === normalizedContestType);
  const employees = readJson(EMPLOYEES_PATH);
  const results = buildResults(normalizedContestType);
  const videoIndexById = new Map(videos.map((video, index) => [video.id, index]));

  const summaryRows = [["????", contestLabel], ["? ???", results.totalEligible], ["? ?? ?", results.totalVoters], ["? ?? ?", results.totalSelections], []];
  summaryRows.push(["??", "???", "?? ?", "??"]);

  videos.forEach((video, index) => {
    const count = results.voteCounts[video.id] || 0;
    const percentage = results.totalSelections > 0 ? Math.round((count / results.totalSelections) * 100) : 0;
    summaryRows.push([
      String(index + 1).padStart(2, "0"),
      stripLeadingNumber(video.title),
      count,
      `${percentage}%`
    ]);
  });

  const voteRows = [["????", "????", "??", "?? ??", "?? ??"]];
  votes.forEach((vote) => {
    const selectedNumbers = normalizeVoteVideoIds(vote).map((videoId) => {
      const index = videoIndexById.get(videoId);
      return typeof index === "number" ? String(index + 1).padStart(2, "0") : videoId;
    });

    voteRows.push([
      contestLabel,
      vote.employeeNumber,
      vote.voterName,
      selectedNumbers[0] || "",
      vote.submittedAt
    ]);
  });

  const pendingRows = [["????", "????", "??", "??"]];
  const votedEmployeeNumbers = new Set(votes.map((vote) => vote.employeeNumber));
  employees
    .filter((employee) => !votedEmployeeNumbers.has(employee.employeeNumber))
    .forEach((employee) => {
      pendingRows.push([contestLabel, employee.employeeNumber, employee.voterName, "?? ??"]);
    });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "?? ??");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(voteRows), "?? ??");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(pendingRows), "??? ??");

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx"
  });

  response.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(`2026-${normalizedContestType}-contest-results.xlsx`)}"`
  });
  response.end(buffer);
}

function handleVideoImportTemplate(response) {
  const rows = [
    ["contestType", "title", "submitter", "description", "lyrics", "url"],
    ["video", "01. 영상 제목", "홍길동", "영상 소개 문구입니다.", "", "https://www.youtube.com/watch?v=example"],
    ["bgm", "01. AI Music Contest", "홍길동", "음악 소개 문구입니다.", "이곳에 가사를 입력합니다.", ""]
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "??????");

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx"
  });

  response.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${encodeURIComponent("2026-contest-import-template.xlsx")}"`
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
      uploadError = "?? ??(.xlsx, .xls)? ???? ? ????.";
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
      return sendJson(response, 400, { message: "???? ?? ??? ??? ???." });
    }

    try {
      const workbook = XLSX.read(Buffer.concat(chunks), { type: "buffer" });
      const firstSheetName = workbook.SheetNames[0];
      const firstSheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

      if (!rows.length) {
        return sendJson(response, 400, { message: "?? ??? ??? ?? ??? ????." });
      }

      const importedVideos = [];

      for (const row of rows) {
        const payload = normalizeVideoPayload({
          contestType: row.contestType || row["???? ??"] || row["contest"] || row["type"],
          title: row.title || row["?? ??"] || row["??"],
          submitter: row.submitter || row["???"],
          description: row.description || row["??"],
          lyrics: row.lyrics || row["가사"] || row["lyricsText"],
          type: normalizeContestType(row.contestType || row["???? ??"] || row["contest"] || row["type"]) === "bgm" ? "audio" : "youtube",
          url: row.url || row["?? ??"] || row["??? ??"]
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
          message: "??? ?? ????. contestType, ?? ??, ???, ??, ?? ??? ??? ???."
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
        message: `${importedVideos.length}?? ???? ??? ??????.`,
        count: importedVideos.length,
        videos: importedVideos
      });
    } catch (error) {
      return sendJson(response, 400, { message: "?? ??? ?? ? ??? ??????." });
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
  const contestType = normalizeContestType(payload.contestType);
  const title = sanitizeText(payload.title);
  const submitter = sanitizeText(payload.submitter);
  const description = sanitizeText(payload.description);
  const lyrics = sanitizeText(payload.lyrics);
  const type = contestType === "bgm" ? "audio" : sanitizeText(payload.type || "youtube");
  const url = sanitizeText(payload.url);

  if (!title || !submitter || !description) {
    return null;
  }

  if (contestType === "video" && (!url || type !== "youtube")) {
    return null;
  }

  if (contestType === "bgm" && type !== "audio") {
    return null;
  }

  return { contestType, title, submitter, description, lyrics, type, url };
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

function findVote(employeeNumber, contestType = "") {
  const votes = readJson(VOTES_PATH);
  const normalizedContestType = contestType ? normalizeContestType(contestType) : "";
  return votes.find((vote) => {
    if (vote.employeeNumber !== employeeNumber) {
      return false;
    }

    return normalizedContestType ? vote.contestType === normalizedContestType : true;
  }) || null;
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
    return normalizeStoragePayload(filePath, cloneJson(databaseState.cache[storageKey]));
  }

  return normalizeStoragePayload(filePath, JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function writeJson(filePath, payload) {
  const normalizedPayload = normalizeStoragePayload(filePath, payload);

  if (USE_DATABASE_STORAGE) {
    const storageKey = STORAGE_KEY_BY_PATH.get(filePath);
    if (!storageKey) {
      throw new Error(`Unsupported storage path in database mode: ${filePath}`);
    }

    const nextPayload = cloneJson(normalizedPayload);
    databaseState.cache[storageKey] = nextPayload;
    persistDatabasePayload(storageKey, nextPayload);
    return;
  }

  const nextContent = JSON.stringify(normalizedPayload, null, 2);
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
