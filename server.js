const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

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

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

ensureDataFiles();

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = requestUrl.pathname;

  if (pathname === "/api/videos" && request.method === "GET") {
    return sendJson(response, 200, readJson(VIDEOS_PATH));
  }

  if (pathname === "/api/meta" && request.method === "GET") {
    return sendJson(response, 200, readJson(STATE_PATH));
  }

  if (pathname === "/healthz" && request.method === "GET") {
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === "/api/eligible-voter" && request.method === "GET") {
    return handleEligibleVoterLookup(response, requestUrl.searchParams);
  }

  if (pathname === "/api/results" && request.method === "GET") {
    return sendJson(response, 200, buildResults());
  }

  if (pathname === "/api/vote" && request.method === "POST") {
    return handleVote(request, response);
  }

  if (pathname === "/api/vote" && request.method === "PUT") {
    return handleVoteUpdate(request, response);
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
}

function defaultVideos() {
  return [
    {
      id: "vision-story",
      title: "AI로 바뀌는 우리의 하루",
      submitter: "김선빈",
      description: "AI가 만드는 새로운 업무 경험을 소개하는 출품 영상입니다.",
      type: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    },
    {
      id: "work-smarter",
      title: "더 빠르게, 더 똑똑하게",
      submitter: "업무혁신TF",
      description: "업무 자동화와 협업 개선 사례를 담은 AI 홍보 영상입니다.",
      type: "youtube",
      url: "https://www.youtube.com/watch?v=ysz5S6PUM-U"
    }
  ];
}

function handleEligibleVoterLookup(response, searchParams) {
  const employeeNumber = sanitizeText(searchParams.get("employeeNumber"));
  if (!employeeNumber) {
    return sendJson(response, 400, { message: "사원번호를 입력해 주세요." });
  }

  const employee = findEmployee(employeeNumber);
  if (!employee) {
    return sendJson(response, 404, { message: "등록된 사원번호만 투표할 수 있습니다." });
  }

  return sendJson(response, 200, employee);
}

function buildResults() {
  const videos = readJson(VIDEOS_PATH);
  const votes = readJson(VOTES_PATH);
  const voteCounts = videos.reduce((accumulator, video) => {
    accumulator[video.id] = 0;
    return accumulator;
  }, {});

  votes.forEach((vote) => {
    if (voteCounts[vote.videoId] !== undefined) {
      voteCounts[vote.videoId] += 1;
    }
  });

  return {
    totalVotes: votes.length,
    voteCounts
  };
}

async function handleVote(request, response) {
  try {
    const payload = JSON.parse((await readRequestBody(request)) || "{}");
    const employeeNumber = sanitizeText(payload.employeeNumber);
    const videoId = sanitizeText(payload.videoId);
    const state = readJson(STATE_PATH);
    const videos = readJson(VIDEOS_PATH);
    const votes = readJson(VOTES_PATH);
    const employee = findEmployee(employeeNumber);

    if (!employeeNumber || !videoId) {
      return sendJson(response, 400, { message: "사원번호와 영상을 선택해 주세요." });
    }

    if (!employee) {
      return sendJson(response, 403, { message: "등록된 사원번호만 투표할 수 있습니다." });
    }

    if (state.votingClosed) {
      return sendJson(response, 403, { message: "투표가 마감되어 더 이상 참여할 수 없습니다." });
    }

    if (!videos.some((video) => video.id === videoId)) {
      return sendJson(response, 400, { message: "선택한 영상 정보가 올바르지 않습니다." });
    }

    if (votes.some((vote) => vote.employeeNumber === employeeNumber)) {
      return sendJson(response, 409, { message: "해당 사원번호는 이미 투표를 완료했습니다." });
    }

    const newVote = {
      employeeNumber,
      voterName: employee.voterName,
      videoId,
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

async function handleVoteUpdate(request, response) {
  try {
    const payload = JSON.parse((await readRequestBody(request)) || "{}");
    const employeeNumber = sanitizeText(payload.employeeNumber);
    const videoId = sanitizeText(payload.videoId);
    const state = readJson(STATE_PATH);
    const videos = readJson(VIDEOS_PATH);
    const votes = readJson(VOTES_PATH);
    const employee = findEmployee(employeeNumber);

    if (!employeeNumber || !videoId) {
      return sendJson(response, 400, { message: "사원번호와 영상을 선택해 주세요." });
    }

    if (!employee) {
      return sendJson(response, 403, { message: "등록된 사원번호만 투표할 수 있습니다." });
    }

    if (state.votingClosed) {
      return sendJson(response, 403, { message: "투표가 마감되어 더 이상 참여할 수 없습니다." });
    }

    if (!videos.some((video) => video.id === videoId)) {
      return sendJson(response, 400, { message: "선택한 영상 정보가 올바르지 않습니다." });
    }

    const voteIndex = votes.findIndex((vote) => vote.employeeNumber === employeeNumber);
    if (voteIndex < 0) {
      return sendJson(response, 404, { message: "기존 투표 정보를 찾지 못했습니다." });
    }

    votes[voteIndex] = {
      ...votes[voteIndex],
      voterName: employee.voterName,
      videoId,
      submittedAt: new Date().toISOString()
    };
    writeJson(VOTES_PATH, votes);

    return sendJson(response, 200, {
      message: "투표가 변경되었습니다.",
      voterName: votes[voteIndex].voterName,
      submittedAt: votes[voteIndex].submittedAt
    });
  } catch (error) {
    return sendJson(response, 500, { message: "서버에서 투표 변경을 처리하지 못했습니다." });
  }
}

async function handleVideoCreate(request, response) {
  try {
    const videos = readJson(VIDEOS_PATH);
    const payload = normalizeVideoPayload(JSON.parse((await readRequestBody(request)) || "{}"));
    if (!payload) {
      return sendJson(response, 400, { message: "영상 정보를 모두 올바르게 입력해 주세요." });
    }

    videos.push({ id: createVideoId(payload.title, videos), ...payload });
    writeJson(VIDEOS_PATH, videos);
    return sendJson(response, 201, { message: "영상이 등록되었습니다." });
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

    videos[index] = { id, ...payload };
    writeJson(VIDEOS_PATH, videos);
    return sendJson(response, 200, { message: "영상이 수정되었습니다." });
  } catch (error) {
    return sendJson(response, 500, { message: "영상 수정에 실패했습니다." });
  }
}

function handleVideoDelete(response, id) {
  const videos = readJson(VIDEOS_PATH);
  const votes = readJson(VOTES_PATH);
  const nextVideos = videos.filter((video) => video.id !== id);

  if (nextVideos.length === videos.length) {
    return sendJson(response, 404, { message: "삭제할 영상을 찾지 못했습니다." });
  }

  writeJson(VIDEOS_PATH, nextVideos);
  writeJson(VOTES_PATH, votes.filter((vote) => vote.videoId !== id));
  return sendJson(response, 200, { message: "영상과 관련 투표가 삭제되었습니다." });
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

function findEmployee(employeeNumber) {
  const employees = readJson(EMPLOYEES_PATH);
  return employees.find((employee) => employee.employeeNumber === employeeNumber) || null;
}

function isAuthorizedAdmin(request) {
  return request.headers["x-admin-password"] === ADMIN_PASSWORD;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
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
