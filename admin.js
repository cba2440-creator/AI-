const API_BASE = "/api/admin";
const ADMIN_SESSION_KEY = "ai-awards-admin-session";
const ADMIN_MASK_VALUE = "••••••••••";

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
const titleInput = document.querySelector("#video-title");
const submitterInput = document.querySelector("#video-submitter");
const descriptionInput = document.querySelector("#video-description");
const urlInput = document.querySelector("#video-url");
const videoFileInput = document.querySelector("#video-file");
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

let adminPassword = "";
let isAuthenticated = false;
let pendingPasswordResolver = null;
let pendingConfirmResolver = null;

setAuthStatus("관리자 비밀번호를 입력해 주세요.");
setAdminUIEnabled(false);
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
  showToast("인증되었습니다.");
  await loadDashboard();
});

videoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensurePassword()) {
    return;
  }

  const payload = {
    title: titleInput.value.trim(),
    submitter: submitterInput.value.trim(),
    description: descriptionInput.value.trim(),
    type: "youtube",
    url: urlInput.value.trim()
  };

  if (!payload.title || !payload.submitter || !payload.description || !payload.url) {
    setAuthStatus("영상 정보를 모두 입력해 주세요.", "warning");
    return;
  }

  const method = videoIdInput.value ? "PUT" : "POST";
  const endpoint = videoIdInput.value ? `${API_BASE}/videos/${videoIdInput.value}` : `${API_BASE}/videos`;

  const response = await adminFetch(endpoint, {
    method,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok) {
    setAuthStatus(result.message || "영상 저장에 실패했습니다.", "warning");
    return;
  }

  const savedVideoId = result.video?.id || videoIdInput.value;

  if (videoFileInput.files[0] && savedVideoId) {
    const uploadFormData = new FormData();
    uploadFormData.append("videoFile", videoFileInput.files[0]);

    const uploadResponse = await fetch(`${API_BASE}/videos/${savedVideoId}/upload`, {
      method: "POST",
      headers: {
        "x-admin-password": adminPassword
      },
      body: uploadFormData
    });
    const uploadResult = await uploadResponse.json();

    if (!uploadResponse.ok) {
      setAuthStatus(uploadResult.message || "영상 파일 업로드에 실패했습니다.", "warning");
      return;
    }
  }

  clearVideoForm();
  setAuthStatus(result.message || "영상이 저장되었습니다.", "success");
  showToast(result.message || "영상이 저장되었습니다.");
  await loadDashboard();
});

videoFormResetButton.addEventListener("click", () => {
  clearVideoForm();
  setAuthStatus("입력 내용이 초기화되었습니다.");
});

downloadVideoTemplateButton?.addEventListener("click", async () => {
  if (!ensurePassword()) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/video-import-template`);
  if (!response.ok) {
    await handleAuthFailure(response);
    return;
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "2026-ai-video-import-template.xlsx";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
  showToast("엑셀 양식이 다운로드되었습니다.");
});

videoBulkForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensurePassword()) {
    return;
  }

  const file = videoBulkFileInput?.files?.[0];
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
    setAuthStatus(result.message || "엑셀 덮어쓰기 등록에 실패했습니다.", "warning");
    return;
  }

  videoBulkForm.reset();
  setAuthStatus(result.message || "엑셀 덮어쓰기 등록이 완료되었습니다.", "success");
  showToast(result.message || "엑셀 덮어쓰기 등록이 완료되었습니다.");
  await loadDashboard();
});

downloadEmployeeTemplateButton?.addEventListener("click", async () => {
  if (!ensurePassword()) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/employee-import-template`);
  if (!response.ok) {
    await handleAuthFailure(response);
    return;
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "2026-ai-employee-import-template.xlsx";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
  showToast("직원 양식이 다운로드되었습니다.");
});

employeeBulkForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ensurePassword()) {
    return;
  }

  const file = employeeBulkFileInput?.files?.[0];
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
    setAuthStatus(result.message || "직원 명단 덮어쓰기 등록에 실패했습니다.", "warning");
    return;
  }

  employeeBulkForm.reset();
  setAuthStatus(result.message || "직원 명단 덮어쓰기 등록이 완료되었습니다.", "success");
  showToast(result.message || "직원 명단 덮어쓰기 등록이 완료되었습니다.");
  await loadDashboard();
});

resetVotesButton.addEventListener("click", async () => {
  if (!ensurePassword()) {
    return;
  }

  const confirmed = await requestConfirmation("전체 투표를 초기화하시겠습니까?");
  if (!confirmed) {
    return;
  }

  const secondPassword = await requestPasswordConfirmation();
  if (secondPassword === null) {
    return;
  }

  const response = await fetch(`${API_BASE}/reset-votes`, {
    method: "POST",
    headers: {
      "x-admin-password": secondPassword
    }
  });

  const result = await response.json();
  if (!response.ok) {
    setAuthStatus(result.message || "투표 초기화에 실패했습니다.", "warning");
    return;
  }

  setAuthStatus(result.message, "success");
  showToast("초기화 완료되었습니다.");
  await loadDashboard();
});

closeVotingButton.addEventListener("click", async () => {
  await updateVotingState("close-voting", "마감되었습니다.");
});

openVotingButton.addEventListener("click", async () => {
  await updateVotingState("open-voting", "마감 해제되었습니다.");
});

downloadResultsButton.addEventListener("click", async () => {
  if (!ensurePassword()) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/export-results`);
  if (!response.ok) {
    await handleAuthFailure(response);
    return;
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "2026-ai-video-awards-results.xlsx";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
  showToast("엑셀 파일을 다운로드했습니다.");
});

passwordModalClose.addEventListener("click", () => closePasswordModal(null));
passwordModalCancel.addEventListener("click", () => closePasswordModal(null));
passwordModalConfirm.addEventListener("click", () => closePasswordModal(passwordModalInput.value));
confirmModalClose.addEventListener("click", () => closeConfirmModal(false));
confirmModalCancel.addEventListener("click", () => closeConfirmModal(false));
confirmModalConfirm.addEventListener("click", () => closeConfirmModal(true));

passwordModal.addEventListener("click", (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset.closePasswordModal === "true") {
    closePasswordModal(null);
  }
});

confirmModal.addEventListener("click", (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset.closeConfirmModal === "true") {
    closeConfirmModal(false);
  }
});

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
  isAuthenticated = true;
  setAdminUIEnabled(true);
  renderVideoList(payload.videos);
  renderResults(payload.results, payload.videos);
  renderVoteLog(payload.votes, payload.videos);
  setAuthStatus("관리자 기능이 활성화되었습니다.", "success");
  closeVotingButton.disabled = Boolean(payload.meta.votingClosed);
  openVotingButton.disabled = !payload.meta.votingClosed;
}

function renderVideoList(videos) {
  adminVideoList.innerHTML = videos.map((video) => `
    <article class="admin-video-card">
      <div>
        <strong>${escapeHtml(video.title)}</strong>
        <div class="admin-video-card__meta">${escapeHtml(video.submitter)}</div>
        <div class="admin-video-card__meta">${escapeHtml(video.description)}</div>
        <div class="admin-video-card__link">${escapeHtml(video.url)}</div>
        <div class="admin-video-card__meta">${video.localVideoUrl ? "사이트 재생용 파일 등록됨" : "사이트 재생용 파일 없음"}</div>
      </div>
      <div class="admin-video-card__actions">
        <button class="button button--ghost" type="button" data-action="edit" data-id="${escapeHtml(video.id)}">수정</button>
        <button class="button button--ghost" type="button" data-action="delete" data-id="${escapeHtml(video.id)}">삭제</button>
      </div>
    </article>
  `).join("");

  adminVideoList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      const id = button.dataset.id;
      if (action === "edit") {
        populateVideoForm(videos.find((video) => video.id === id));
      }
      if (action === "delete") {
        deleteVideo(id);
      }
    });
  });
}

function renderResults(results, videos) {
  const totalSelections = results.totalSelections || 0;

  adminResults.innerHTML = videos.map((video) => {
    const count = results.voteCounts[video.id] || 0;
    const percentage = totalSelections > 0 ? Math.round((count / totalSelections) * 100) : 0;
    return `
      <div class="result-item">
        <div class="result-item__header">
          <div class="result-item__title">${escapeHtml(video.title)}</div>
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
    adminVoteLog.innerHTML = '<div class="admin-vote-empty">아직 저장된 투표가 없습니다.</div>';
    return;
  }

  adminVoteLog.innerHTML = votes.map((vote) => {
    const selectedTitles = normalizeVoteVideoIds(vote)
      .map((videoId) => {
        const found = videos.find((video) => video.id === videoId);
        return found ? stripLeadingNumber(found.title) : videoId;
      })
      .join(", ");

    return `
      <div class="admin-vote-item">
        <div class="admin-vote-item__content">
          <strong>${escapeHtml(vote.employeeNumber)} · ${escapeHtml(vote.voterName)}</strong>
          <div class="admin-vote-item__meta">선택 작품: ${escapeHtml(selectedTitles)}</div>
          <div class="admin-vote-item__meta">${new Date(vote.submittedAt).toLocaleString("ko-KR")}</div>
        </div>
        <button class="button button--ghost" type="button" data-delete-vote="${escapeHtml(vote.employeeNumber)}">삭제</button>
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
  titleInput.value = video.title;
  submitterInput.value = video.submitter || "";
  descriptionInput.value = video.description || "";
  urlInput.value = video.url;
  setAuthStatus("수정할 영상 정보를 불러왔습니다.");
}

async function deleteVideo(id) {
  if (!ensurePassword()) {
    return;
  }

  const confirmed = await requestConfirmation("이 영상을 삭제하시겠습니까? 관련 투표도 함께 제거됩니다.");
  if (!confirmed) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/videos/${id}`, {
    method: "DELETE"
  });
  const result = await response.json();

  if (!response.ok) {
    setAuthStatus(result.message || "영상 삭제에 실패했습니다.", "warning");
    return;
  }

  clearVideoForm();
  setAuthStatus(result.message, "success");
  showToast(result.message);
  await loadDashboard();
}

async function deleteVote(employeeNumber) {
  if (!ensurePassword()) {
    return;
  }

  const confirmed = await requestConfirmation("해당 직원의 투표를 삭제하시겠습니까? 삭제 후에는 다시 투표할 수 있습니다.");
  if (!confirmed) {
    return;
  }

  const response = await adminFetch(`${API_BASE}/votes/${encodeURIComponent(employeeNumber)}`, {
    method: "DELETE"
  });
  const result = await response.json();

  if (!response.ok) {
    setAuthStatus(result.message || "개별 투표 삭제에 실패했습니다.", "warning");
    return;
  }

  setAuthStatus(result.message, "success");
  showToast("해당 직원의 투표를 삭제했습니다.");
  await loadDashboard();
}

function clearVideoForm() {
  videoForm.reset();
  videoIdInput.value = "";
  videoFileInput.value = "";
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
  if (videoBulkForm) {
    Array.from(videoBulkForm.elements).forEach((element) => {
      element.disabled = !enabled;
    });
  }
  if (downloadVideoTemplateButton) {
    downloadVideoTemplateButton.disabled = !enabled;
  }
  if (employeeBulkForm) {
    Array.from(employeeBulkForm.elements).forEach((element) => {
      element.disabled = !enabled;
    });
  }
  if (downloadEmployeeTemplateButton) {
    downloadEmployeeTemplateButton.disabled = !enabled;
  }
  resetVotesButton.disabled = !enabled;
  closeVotingButton.disabled = !enabled;
  openVotingButton.disabled = !enabled;
  downloadResultsButton.disabled = !enabled;
}

function showToast(message) {
  adminToast.textContent = message;
  adminToast.className = "admin-toast is-visible";
  window.clearTimeout(showToast.timerId);
  showToast.timerId = window.setTimeout(() => {
    adminToast.className = "admin-toast";
  }, 2200);
}

async function updateVotingState(endpoint, successMessage) {
  if (!ensurePassword()) {
    return;
  }

  const secondPassword = await requestPasswordConfirmation();
  if (secondPassword === null) {
    return;
  }

  const response = await fetch(`${API_BASE}/${endpoint}`, {
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

  setAuthStatus(successMessage, "success");
  showToast(successMessage);
  await loadDashboard();
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

function restoreAdminSession() {
  try {
    const savedPassword = sessionStorage.getItem(ADMIN_SESSION_KEY) || "";
    if (!savedPassword) {
      return;
    }

    adminPassword = savedPassword;
    passwordInput.value = "";
    authenticateAdmin().then((authenticated) => {
      if (authenticated) {
        showMaskedPassword();
        loadDashboard();
      }
    });
  } catch {}
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
