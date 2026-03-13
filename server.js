const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const XLSX = require("xlsx");
const Busboy = require("busboy");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "iparkmall2020!";
const ROOT = __dirname;
const DATA_DIR = path.isAbsolute(process.env.DATA_DIR || "")
  ? process.env.DATA_DIR
  : path.join(ROOT, process.env.DATA_DIR || "data");
const VIDEOS_PATH = path.join(DATA_DIR, "videos.json");
const VOTES_PATH = path.join(DATA_DIR, "votes.json");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const EMPLOYEES_PATH = path.join(DATA_DIR, "employees.json");
const MEDIA_DIR = path.join(DATA_DIR, "uploads");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MEDIA_BACKUP_DIR = path.join(BACKUP_DIR, "uploads");
const JSON_BACKUP_RETENTION = 40;
const MEDIA_BACKUP_RETENTION = 20;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

ensureDataFiles();

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
});

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

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

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  if (!fs.existsSync(MEDIA_BACKUP_DIR)) {
    fs.mkdirSync(MEDIA_BACKUP_DIR, { recursive: true });
  }
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

    if (videoIds.length < 1 || videoIds.length > 3) {
      return sendJson(response, 400, { message: "최소 1개에서 최대 3개 작품까지 선택해 주세요." });
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
    ["영상 번호", "작품명", "득표 수", "득표율(%)"]
  ];

  videos.forEach((video, index) => {
    const count = results.voteCounts[video.id] || 0;
    const percentage = results.totalSelections > 0 ? Number(((count / results.totalSelections) * 100).toFixed(2)) : 0;
    summaryRows.push([String(index + 1).padStart(2, "0"), stripLeadingNumber(video.title), count, percentage]);
  });

  const voteRows = [
    ["사원번호", "이름", "선택 1", "선택 2", "선택 3", "제출 시각"]
  ];

  votes.forEach((vote) => {
    const selectedTitles = normalizeVoteVideoIds(vote).map((videoId) => {
      const found = videos.find((video) => video.id === videoId);
      return found ? stripLeadingNumber(found.title) : videoId;
    });

    voteRows.push([
      vote.employeeNumber,
      vote.voterName,
      selectedTitles[0] || "",
      selectedTitles[1] || "",
      selectedTitles[2] || "",
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
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream"
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
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
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
