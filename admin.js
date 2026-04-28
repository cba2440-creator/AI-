const API_BASE = "/api/admin";
const ADMIN_SESSION_KEY = "ai-awards-admin-session";
const ADMIN_MASK_VALUE = "••••••••";

const CONTEST_COPY = {
  video: {
    title: "2026 AI Video Contest 관리자",
    description: "영상 콘테스트 출품작과 투표 현황을 관리합니다.",
    listTitle: "출품 영상 목록",
    resultTitle: "AI Video Contest 투표 관리",
    voteLogTitle: "AI Video Contest 개인별 투표 현황"
  },
  bgm: {
    title: "2026 AI Music Contest 관리자",
    description: "AI Music Contest 출품곡과 투표 현황을 관리합니다.",
    listTitle: "출품 음악 목록",
    resultTitle: "AI Music Contest 투표 관리",
    voteLogTitle: "AI Music Contest 개인별 투표 현황"
  }
};

const authForm = document.querySelector("#admin-auth-form");
const passwordInput = document.querySelector("#admin-password");
const authStatus = document.querySelector("#admin-auth-status");
const adminToast = document.querySelector("#admin-toast");
const passwordModal = document.querySelector("#password-modal");
const passwordModalInput = document.querySelector("#password-modal-input");
const passwordModalClose = document.querySelector("#password-modal-close");
const passwordModalCancel = document.querySelector("#password-modal-cancel");
const passwordModalConfirm = document.querySelector("#password-modal-confirm");
const confirmModal = document.querySelector("#confirm-modal");
const confirmModalMessage = document.querySelector("#confirm-modal-message");
const confirmModalClose = document.querySelector("#confirm-modal-close");
const confirmModalCancel = document.querySelector("#confirm-modal-cancel");
const confirmModalConfirm = document.querySelector("#confirm-modal-confirm");
const videoForm = document.querySelector("#video-form");
const videoIdInput = document.querySelector("#video-id");
const videoContestTypeInput = document.querySelector("#video-contest-type");
const titleInput = document.querySelector("#video-title");
const submitterInput = document.querySelector("#video-submitter");
const descriptionInput = document.querySelector("#video-description");
const lyricsField = document.querySelector("#lyrics-field");
const lyricsInput = document.querySelector("#video-lyrics");
const urlInput = document.querySelector("#video-url");
const videoFileInput = document.querySelector("#video-file");
const videoUrlLabel = document.querySelector("#video-url-label");
const videoFileLabel = document.querySelector("#video-file-label");
const videoFormDescription = document.querySelector("#video-form-description");
const videoFormHint = document.querySelector("#video-form-hint");
const videoFormResetButton = document.querySelector("#video-form-reset");
const downloadVideoTemplateButton = document.querySelector("#download-video-template");
const videoBulkForm = document.querySelector("#video-bulk-form");
const videoBulkFileInput = document.querySelector("#video-bulk-file");
const downloadEmployeeTemplateButton = document.querySelector("#download-employee-template");
const employeeBulkForm = document.querySelector("#employee-bulk-form");
const employeeBulkFileInput = document.querySelector("#employee-bulk-file");
const adminVideoList = document.querySelector("#admin-video-list");
const adminResults = document.querySelector("#admin-results");
const adminVoteLog = document.querySelector("#admin-vote-log");
const resetVotesButton = document.querySelector("#reset-votes");
const closeVotingButton = document.querySelector("#close-voting");
const openVotingButton = document.querySelector("#open-voting");
const downloadResultsButton = document.querySelector("#download-results");
const publicContestTypeInput = document.querySelector("#public-contest-type");
const savePublicContestButton = document.querySelector("#save-public-contest");
const adminContestTitle = document.querySelector("#admin-contest-title");
const adminContestDescription = document.querySelector("#admin-contest-description");
const adminListTitle = document.querySelector("#admin-list-title");
const adminResultTitle = document.querySelector("#admin-result-title");
const adminVoteLogTitle = document.querySelector("#admin-vote-log-title");
const contestButtons = Array.from(document.querySelectorAll(".contest-switch__button"));

let adminPassword = "";
let isAuthenticated = false;
let activeContestType = "video";
let publicContestType = "video";
let pendingPasswordResolver = null;
let pendingConfirmResolver = null;

setAuthStatus("관리자 비밀번호를 입력해 주세요.");
setAdminUIEnabled(false);
applyContestTheme();
syncContestTypeFormState();
restoreAdminSession();

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminPassword = passwordInput.value.trim();

  if (!adminPassword) {
    setAuthStatus("관리자 비밀번호를 입력해 주세요.", "warning");
    return;
  }

  const authenticated = await authenticateAdmin();
  if (!authenticated) {
    return;
  }

  persistAdminSession();
  showMaskedPassword();
  showToast("인증되었습니다.", "success");
  await loadDashboard();
});

contestButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const nextContestType = button.dataset.contestType || "video";
    if (nextContestType === activeContestType) {
      return;
    }

    activeContestType = nextContestType;
    videoContestTypeInput.value = activeContestType;
    applyContestTheme();
    syncContestTypeFormState();

    if (isAuthenticated) {
      await loadDashboard();
    }
  });
});

videoContestTypeInput.addEventListener("change", syncContestTypeFormState);

savePublicContestButton.addEventListener("click", async () => {
  if (!ensurePassword()) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/public-contest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      publicContestType: publicContestTypeInput.value || "video"
    })
  });
  const result = await response.json();

  if (!response.ok) {
    setAuthStatus(result.message || "노출 콘테스트 저장에 실패했습니다.", "warning");
    return;
  }

  publicContestType = result.publicContestType || publicContestTypeInput.value || "video";
  publicContestTypeInput.value = publicContestType;
  setAuthStatus(result.message || "사용자 페이지 노출 콘테스트를 저장했습니다.", "success");
  showToast(result.message || "사용자 페이지 노출 콘테스트를 저장했습니다.", "success");
});

videoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensurePassword()) {
    return;
  }

  const contestType = videoContestTypeInput.value || activeContestType;
  const payload = {
    contestType,
    title: titleInput.value.trim(),
    submitter: submitterInput.value.trim(),
    description: descriptionInput.value.trim(),
    lyrics: lyricsInput.value.trim(),
    type: contestType === "bgm" ? "audio" : "youtube",
    url: urlInput.value.trim()
  };

  if (!payload.title || !payload.submitter || !payload.description) {
    setAuthStatus("작품 정보는 모두 입력해 주세요.", "warning");
    return;
  }

  if (contestType === "video" && !payload.url) {
    setAuthStatus("영상 콘테스트는 영상 링크를 입력해 주세요.", "warning");
    return;
  }

  if (contestType === "bgm" && !videoIdInput.value && !videoFileInput.files?.[0]) {
    setAuthStatus("AI Music Contest는 음악 파일을 업로드해 주세요.", "warning");
    return;
  }

  const isEditing = Boolean(videoIdInput.value);
  const endpoint = isEditing ? `${API_BASE}/videos/${encodeURIComponent(videoIdInput.value)}` : `${API_BASE}/videos`;
  const method = isEditing ? "PUT" : "POST";

  const response = await adminFetch(endpoint, {
    method,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json();

  if (!response.ok) {
    setAuthStatus(result.message || "작품 저장에 실패했습니다.", "warning");
    return;
  }

  const savedVideoId = result.video?.id || videoIdInput.value;
  const uploadFile = videoFileInput.files?.[0];
  if (savedVideoId && uploadFile) {
    const formData = new FormData();
    formData.append("videoFile", uploadFile);

    const uploadResponse = await fetch(`${API_BASE}/videos/${encodeURIComponent(savedVideoId)}/upload`, {
      method: "POST",
      headers: {
        "x-admin-password": adminPassword
      },
      body: formData
    });
    const uploadResult = await uploadResponse.json();

    if (!uploadResponse.ok) {
      setAuthStatus(uploadResult.message || "미디어 파일 업로드에 실패했습니다.", "warning");
      return;
    }
  }

  clearVideoForm();
  setAuthStatus(result.message || "작품을 저장했습니다.", "success");
  showToast(result.message || "작품을 저장했습니다.", "success");
  await loadDashboard();
});

videoFormResetButton.addEventListener("click", () => {
  clearVideoForm();
  setAuthStatus("입력 내용을 초기화했습니다.");
});

downloadVideoTemplateButton.addEventListener("click", async () => {
  if (!ensurePassword()) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/video-import-template`);
  if (!response.ok) {
    await handleAuthFailure(response);
    return;
  }

  downloadBlob(await response.blob(), "2026-contest-import-template.xlsx");
  showToast("작품 양식을 다운로드했습니다.", "success");
});

videoBulkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensurePassword()) {
    return;
  }

  const file = videoBulkFileInput.files?.[0];
  if (!file) {
    setAuthStatus("업로드할 엑셀 파일을 선택해 주세요.", "warning");
    return;
  }

  const formData = new FormData();
  formData.append("videoSheet", file);

  const response = await fetch(`${API_BASE}/import-videos`, {
    method: "POST",
    headers: {
      "x-admin-password": adminPassword
    },
    body: formData
  });
  const result = await response.json();

  if (!response.ok) {
    setAuthStatus(result.message || "작품 엑셀 등록에 실패했습니다.", "warning");
    return;
  }

  videoBulkForm.reset();
  setAuthStatus(result.message || "작품 엑셀 등록이 완료되었습니다.", "success");
  showToast(result.message || "작품 엑셀 등록이 완료되었습니다.", "success");
  await loadDashboard();
});

downloadEmployeeTemplateButton.addEventListener("click", async () => {
  if (!ensurePassword()) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/employee-import-template`);
  if (!response.ok) {
    await handleAuthFailure(response);
    return;
  }

  downloadBlob(await response.blob(), "2026-ai-employee-import-template.xlsx");
  showToast("직원 양식을 다운로드했습니다.", "success");
});

employeeBulkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensurePassword()) {
    return;
  }

  const file = employeeBulkFileInput.files?.[0];
  if (!file) {
    setAuthStatus("업로드할 엑셀 파일을 선택해 주세요.", "warning");
    return;
  }

  const formData = new FormData();
  formData.append("employeeSheet", file);

  const response = await fetch(`${API_BASE}/import-employees`, {
    method: "POST",
    headers: {
      "x-admin-password": adminPassword
    },
    body: formData
  });
  const result = await response.json();

  if (!response.ok) {
    setAuthStatus(result.message || "직원 명단 등록에 실패했습니다.", "warning");
    return;
  }

  employeeBulkForm.reset();
  setAuthStatus(result.message || "직원 명단 등록이 완료되었습니다.", "success");
  showToast(result.message || "직원 명단 등록이 완료되었습니다.", "success");
  await loadDashboard();
});

resetVotesButton.addEventListener("click", async () => {
  const confirmed = await requestConfirmation("현재 콘테스트의 전체 투표를 초기화하시겠습니까?");
  if (!confirmed) {
    return;
  }
  await postContestAction("reset-votes", "전체 투표를 초기화했습니다.");
});

closeVotingButton.addEventListener("click", async () => {
  await postContestAction("close-voting", "투표를 마감했습니다.");
});

openVotingButton.addEventListener("click", async () => {
  await postContestAction("open-voting", "투표 마감을 해제했습니다.");
});

downloadResultsButton.addEventListener("click", async () => {
  if (!ensurePassword()) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/export-results?contestType=${encodeURIComponent(activeContestType)}`);
  if (!response.ok) {
    await handleAuthFailure(response);
    return;
  }

  downloadBlob(await response.blob(), `2026-${activeContestType}-contest-results.xlsx`);
  showToast("결과 파일을 다운로드했습니다.", "success");
});

passwordModalClose.addEventListener("click", () => closePasswordModal(null));
passwordModalCancel.addEventListener("click", () => closePasswordModal(null));
passwordModalConfirm.addEventListener("click", () => closePasswordModal(passwordModalInput.value));
confirmModalClose.addEventListener("click", () => closeConfirmModal(false));
confirmModalCancel.addEventListener("click", () => closeConfirmModal(false));
confirmModalConfirm.addEventListener("click", () => closeConfirmModal(true));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !passwordModal.hidden) {
    closePasswordModal(null);
  }
  if (event.key === "Enter" && !passwordModal.hidden) {
    closePasswordModal(passwordModalInput.value);
  }
  if (event.key === "Escape" && !confirmModal.hidden) {
    closeConfirmModal(false);
  }
  if (event.key === "Enter" && !confirmModal.hidden) {
    closeConfirmModal(true);
  }
});

function applyContestTheme() {
  const copy = CONTEST_COPY[activeContestType] || CONTEST_COPY.video;
  adminContestTitle.textContent = copy.title;
  adminContestDescription.textContent = copy.description;
  adminListTitle.textContent = copy.listTitle;
  adminResultTitle.textContent = copy.resultTitle;
  adminVoteLogTitle.textContent = copy.voteLogTitle;

  contestButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.contestType === activeContestType);
  });
}

async function loadDashboard() {
  if (!ensurePassword()) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/dashboard`);
  if (!response.ok) {
    await handleAuthFailure(response);
    return;
  }

  const payload = await response.json();
  const visibleVideos = payload.videos.filter((video) => (video.contestType || "video") === activeContestType);
  const visibleVotes = payload.votes.filter((vote) => (vote.contestType || "video") === activeContestType);
  const results = payload.resultsByContestType?.[activeContestType] || { totalSelections: 0, voteCounts: {} };
  const votingClosed = Boolean(payload.meta?.votingClosedByContestType?.[activeContestType]);

  publicContestType = payload.meta?.publicContestType || "video";
  publicContestTypeInput.value = publicContestType;

  isAuthenticated = true;
  setAdminUIEnabled(true);
  renderVideoList(visibleVideos);
  renderResults(results, visibleVideos);
  renderVoteLog(visibleVotes, visibleVideos);
  setAuthStatus("관리 기능이 활성화되었습니다.", "success");
  closeVotingButton.disabled = votingClosed;
  openVotingButton.disabled = !votingClosed;
}

function renderVideoList(videos) {
  if (!videos.length) {
    adminVideoList.innerHTML = '<div class="admin-vote-empty">등록된 작품이 없습니다.</div>';
    return;
  }

  adminVideoList.innerHTML = videos.map((video, index) => `
    <article class="admin-video-card">
      <div>
        <strong>${escapeHtml(formatVideoLabel(video, index))}</strong>
        <div class="admin-video-card__meta">출품자: ${escapeHtml(video.submitter || "")}</div>
        <div class="admin-video-card__meta">설명: ${escapeHtml(video.description || "")}</div>
        ${video.contestType === "bgm" ? `<div class="admin-video-card__meta">가사: ${escapeHtml(video.lyrics || "미입력")}</div>` : ""}
        ${video.url ? `<div class="admin-video-card__link">${escapeHtml(video.url)}</div>` : ""}
        <div class="admin-video-card__meta">${escapeHtml(getMediaStatus(video))}</div>
      </div>
      <div class="admin-video-card__actions">
        <button class="button button--ghost" type="button" data-action="edit" data-id="${escapeHtml(video.id)}">수정</button>
        <button class="button button--ghost" type="button" data-action="delete" data-id="${escapeHtml(video.id)}">삭제</button>
      </div>
    </article>
  `).join("");

  adminVideoList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.id;
      if (button.dataset.action === "edit") {
        populateVideoForm(videos.find((video) => video.id === id));
      } else if (button.dataset.action === "delete") {
        deleteVideo(id);
      }
    });
  });
}

function renderResults(results, videos) {
  if (!videos.length) {
    adminResults.innerHTML = '<div class="admin-vote-empty">집계할 작품이 없습니다.</div>';
    return;
  }

  const totalSelections = results.totalSelections || 0;
  adminResults.innerHTML = videos.map((video, index) => {
    const count = results.voteCounts?.[video.id] || 0;
    const percentage = totalSelections > 0 ? Math.round((count / totalSelections) * 100) : 0;
    return `
      <div class="result-item">
        <div class="result-item__header">
          <div class="result-item__title">${escapeHtml(formatVideoLabel(video, index))}</div>
          <div class="result-item__count">${count}표 · ${percentage}%</div>
        </div>
        <div class="result-item__bar">
          <div class="result-item__fill" style="width: ${percentage}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

function renderVoteLog(votes, videos) {
  if (!votes.length) {
    adminVoteLog.innerHTML = '<div class="admin-vote-empty">아직 등록된 투표가 없습니다.</div>';
    return;
  }

  const videoIndexById = new Map(videos.map((video, index) => [video.id, index]));
  adminVoteLog.innerHTML = votes.map((vote) => {
    const selectedTitles = normalizeVoteVideoIds(vote)
      .map((videoId) => {
        const found = videos.find((video) => video.id === videoId);
        return found ? formatVideoLabel(found, videoIndexById.get(videoId) ?? 0) : videoId;
      })
      .join(", ");

    return `
      <div class="admin-vote-item">
        <div class="admin-vote-item__content">
          <strong>${escapeHtml(vote.employeeNumber)} · ${escapeHtml(vote.voterName)}</strong>
          <div class="admin-vote-item__meta">선택 작품: ${escapeHtml(selectedTitles)}</div>
          <div class="admin-vote-item__meta">${escapeHtml(new Date(vote.submittedAt).toLocaleString("ko-KR"))}</div>
        </div>
        <button class="button button--ghost" type="button" data-delete-vote="${escapeHtml(vote.employeeNumber)}">해제</button>
      </div>
    `;
  }).join("");

  adminVoteLog.querySelectorAll("[data-delete-vote]").forEach((button) => {
    button.addEventListener("click", () => deleteVote(button.dataset.deleteVote));
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

function populateVideoForm(video) {
  if (!video) {
    return;
  }

  videoIdInput.value = video.id;
  videoContestTypeInput.value = video.contestType || "video";
  titleInput.value = video.title || "";
  submitterInput.value = video.submitter || "";
  descriptionInput.value = video.description || "";
  lyricsInput.value = video.lyrics || "";
  urlInput.value = video.url || "";
  syncContestTypeFormState();
  setAuthStatus("수정할 작품 정보를 불러왔습니다.");
}

async function deleteVideo(id) {
  if (!ensurePassword()) {
    return;
  }

  const confirmed = await requestConfirmation("선택한 작품을 삭제하시겠습니까?");
  if (!confirmed) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/videos/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  const result = await response.json();

  if (!response.ok) {
    setAuthStatus(result.message || "작품 삭제에 실패했습니다.", "warning");
    return;
  }

  clearVideoForm();
  setAuthStatus(result.message || "작품을 삭제했습니다.", "success");
  showToast(result.message || "작품을 삭제했습니다.", "success");
  await loadDashboard();
}

async function deleteVote(employeeNumber) {
  if (!ensurePassword()) {
    return;
  }

  const confirmed = await requestConfirmation("해당 직원의 현재 콘테스트 투표를 해제하시겠습니까?");
  if (!confirmed) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/votes/${encodeURIComponent(employeeNumber)}?contestType=${encodeURIComponent(activeContestType)}`, {
    method: "DELETE"
  });
  const result = await response.json();

  if (!response.ok) {
    setAuthStatus(result.message || "투표 해제에 실패했습니다.", "warning");
    return;
  }

  setAuthStatus(result.message || "투표를 해제했습니다.", "success");
  showToast(result.message || "투표를 해제했습니다.", "success");
  await loadDashboard();
}

async function postContestAction(endpoint, successMessage) {
  if (!ensurePassword()) {
    return;
  }

  const secondPassword = await requestPasswordConfirmation();
  if (secondPassword === null) {
    return;
  }

  const response = await fetch(`${API_BASE}/${endpoint}?contestType=${encodeURIComponent(activeContestType)}`, {
    method: "POST",
    headers: {
      "x-admin-password": secondPassword.trim()
    }
  });
  const result = await response.json();

  if (!response.ok) {
    setAuthStatus(result.message || "상태 변경에 실패했습니다.", "warning");
    return;
  }

  setAuthStatus(result.message || successMessage, "success");
  showToast(result.message || successMessage, "success");
  await loadDashboard();
}

function clearVideoForm() {
  videoForm.reset();
  videoIdInput.value = "";
  videoContestTypeInput.value = activeContestType;
  lyricsInput.value = "";
  videoFileInput.value = "";
  syncContestTypeFormState();
}

function downloadBlob(blob, fileName) {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

async function adminFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "x-admin-password": adminPassword
    }
  });
}

function ensurePassword() {
  if (adminPassword && isAuthenticated) {
    return true;
  }

  setAuthStatus("먼저 관리자 비밀번호로 인증해 주세요.", "warning");
  return false;
}

async function authenticateAdmin() {
  const response = await adminFetch(`${API_BASE}/dashboard`);
  if (!response.ok) {
    await handleAuthFailure(response);
    return false;
  }

  isAuthenticated = true;
  setAdminUIEnabled(true);
  return true;
}

async function handleAuthFailure(response) {
  let message = "관리자 비밀번호가 올바르지 않습니다.";

  try {
    const result = await response.json();
    message = result.message || message;
  } catch {}

  adminPassword = "";
  isAuthenticated = false;
  clearAdminSession();
  setAdminUIEnabled(false);
  passwordInput.value = "";
  setAuthStatus(message, "warning");
}

function setAdminUIEnabled(enabled) {
  Array.from(videoForm.elements).forEach((element) => {
    element.disabled = !enabled;
  });
  Array.from(videoBulkForm.elements).forEach((element) => {
    element.disabled = !enabled;
  });
  Array.from(employeeBulkForm.elements).forEach((element) => {
    element.disabled = !enabled;
  });

  downloadVideoTemplateButton.disabled = !enabled;
  downloadEmployeeTemplateButton.disabled = !enabled;
  publicContestTypeInput.disabled = !enabled;
  savePublicContestButton.disabled = !enabled;
  resetVotesButton.disabled = !enabled;
  closeVotingButton.disabled = !enabled;
  openVotingButton.disabled = !enabled;
  downloadResultsButton.disabled = !enabled;
  syncContestTypeFormState();
}

function syncContestTypeFormState() {
  const contestType = videoContestTypeInput.value || activeContestType;
  const isMusicContest = contestType === "bgm";
  const formEnabled = Boolean(adminPassword && isAuthenticated);

  if (lyricsField) {
    lyricsField.hidden = !isMusicContest;
  }

  if (videoFormDescription) {
    videoFormDescription.textContent = isMusicContest
      ? "음악 제목, 출품자, 설명, 가사를 입력하고 음악 파일을 업로드해 주세요."
      : "영상 제목, 출품자, 설명, 영상 링크를 입력해 주세요.";
  }

  if (videoUrlLabel) {
    videoUrlLabel.textContent = isMusicContest ? "참고 링크 (선택)" : "영상 링크";
  }

  if (videoFileLabel) {
    videoFileLabel.textContent = isMusicContest ? "음악 파일" : "사이트 재생용 MP4 파일";
  }

  if (videoFormHint) {
    videoFormHint.textContent = isMusicContest
      ? "AI Music Contest는 MP3, WAV, M4A, AAC 파일을 직접 업로드하고 사용자 페이지에서 바로 재생합니다."
      : "영상 콘테스트는 기존처럼 링크 기반으로 운영합니다. 엑셀 등록 시 contestType 열에 video 또는 bgm 값을 넣어 주세요.";
  }

  lyricsInput.disabled = !formEnabled || !isMusicContest;
  urlInput.required = !isMusicContest;
  urlInput.placeholder = isMusicContest ? "선택 사항" : "https://...";
  urlInput.disabled = !formEnabled ? true : false;
  videoFileInput.accept = isMusicContest ? ".mp3,.wav,.m4a,.aac" : "video/mp4";
  videoFileInput.disabled = !formEnabled || !isMusicContest;
}

function getMediaStatus(video) {
  if (video.contestType === "bgm") {
    return video.localVideoUrl ? "음악 파일 등록됨" : "음악 파일 없음";
  }
  return video.localVideoUrl ? "MP4 파일 등록됨" : "외부 링크 사용";
}

function showToast(message, tone = "default") {
  adminToast.textContent = message;
  adminToast.className = "admin-toast is-visible";

  if (tone === "warning") {
    adminToast.classList.add("admin-toast--warning");
  }

  if (tone === "success") {
    adminToast.classList.add("admin-toast--success");
  }

  window.clearTimeout(showToast.timerId);
  showToast.timerId = window.setTimeout(() => {
    adminToast.className = "admin-toast";
  }, 2400);
}

function requestPasswordConfirmation() {
  passwordModal.hidden = false;
  passwordModalInput.value = "";
  passwordModalInput.focus();
  return new Promise((resolve) => {
    pendingPasswordResolver = resolve;
  });
}

function closePasswordModal(value) {
  if (!pendingPasswordResolver) {
    passwordModal.hidden = true;
    return;
  }

  const resolver = pendingPasswordResolver;
  pendingPasswordResolver = null;
  passwordModal.hidden = true;
  resolver(value === null ? null : value.trim());
}

function requestConfirmation(message) {
  confirmModalMessage.textContent = message;
  confirmModal.hidden = false;
  return new Promise((resolve) => {
    pendingConfirmResolver = resolve;
  });
}

function closeConfirmModal(confirmed) {
  if (!pendingConfirmResolver) {
    confirmModal.hidden = true;
    return;
  }

  const resolver = pendingConfirmResolver;
  pendingConfirmResolver = null;
  confirmModal.hidden = true;
  resolver(confirmed);
}

function setAuthStatus(message, tone = "") {
  authStatus.textContent = message;
  authStatus.className = "status-card";

  if (tone === "success") {
    authStatus.classList.add("is-success");
  }
  if (tone === "warning") {
    authStatus.classList.add("is-warning");
  }
}

function stripLeadingNumber(title) {
  return String(title || "").replace(/^\d+\.\s*/, "");
}

function formatVideoLabel(video, index) {
  return `${String(index + 1).padStart(2, "0")}. ${stripLeadingNumber(video.title)}`;
}

function restoreAdminSession() {
  try {
    const savedPassword = sessionStorage.getItem(ADMIN_SESSION_KEY) || "";
    if (!savedPassword) {
      clearVideoForm();
      return;
    }

    adminPassword = savedPassword;
    passwordInput.value = "";
    authenticateAdmin().then((authenticated) => {
      if (!authenticated) {
        return;
      }

      showMaskedPassword();
      clearVideoForm();
      loadDashboard();
    });
  } catch {
    clearVideoForm();
  }
}

function persistAdminSession() {
  try {
    sessionStorage.setItem(ADMIN_SESSION_KEY, adminPassword);
  } catch {}
}

function clearAdminSession() {
  try {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
  } catch {}
}

function showMaskedPassword() {
  passwordInput.value = ADMIN_MASK_VALUE;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
