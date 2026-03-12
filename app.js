const STORAGE_KEY = "company-video-voter-session";
const API_BASE = "/api";

let videos = [];
let resetVersion = 1;
let votingClosed = false;
let currentlyPlayingVideoId = null;
let lookupRequestId = 0;

const form = document.querySelector("#vote-form");
const employeeNumberInput = document.querySelector("#employee-number");
const nameInput = document.querySelector("#voter-name");
const selectedVideo = document.querySelector("#selected-video");
const voteStatus = document.querySelector("#vote-status");
const videoGrid = document.querySelector("#video-grid");
const videoCardTemplate = document.querySelector("#video-card-template");
const descriptionModal = document.querySelector("#description-modal");
const modalCloseButton = document.querySelector("#modal-close");
const modalTitle = document.querySelector("#modal-title");
const modalSubmitter = document.querySelector("#modal-submitter");
const modalDescription = document.querySelector("#modal-description");

const state = {
  submittedVote: loadSubmittedVote(),
  employeeLookup: null
};

initialize();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitVote();
});

employeeNumberInput.addEventListener("input", () => {
  handleEmployeeNumberInput();
});

selectedVideo.addEventListener("change", () => {
  enforceVoteSelectionLimit();
});

modalCloseButton.addEventListener("click", closeDescriptionModal);
descriptionModal.addEventListener("click", (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset.closeModal === "true") {
    closeDescriptionModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !descriptionModal.hidden) {
    closeDescriptionModal();
  }
});

async function initialize() {
  nameInput.readOnly = true;

  try {
    const [videosResponse, metaResponse] = await Promise.all([
      fetch(`${API_BASE}/videos`),
      fetch(`${API_BASE}/meta`)
    ]);

    if (!videosResponse.ok || !metaResponse.ok) {
      throw new Error("초기 데이터를 불러오지 못했습니다.");
    }

    videos = await videosResponse.json();
    const meta = await metaResponse.json();
    resetVersion = meta.resetVersion || 1;
    votingClosed = Boolean(meta.votingClosed);
    syncStoredVoteWithResetVersion();

    renderVoteOptions();
    renderVideoCards();
    renderStatus();
    toggleFormByVotingState();

    if (state.submittedVote) {
      employeeNumberInput.value = state.submittedVote.employeeNumber;
      nameInput.value = state.submittedVote.voterName;
      state.employeeLookup = {
        employeeNumber: state.submittedVote.employeeNumber,
        voterName: state.submittedVote.voterName
      };
      applySelectedVideoIds(state.submittedVote.videoIds || []);
    }
  } catch (error) {
    setStatus("지금은 투표를 진행할 수 없습니다. 잠시 뒤 다시 시도해 주세요.", "warning");
  }
}

async function handleEmployeeNumberInput() {
  if (state.submittedVote) {
    return;
  }

  const employeeNumber = employeeNumberInput.value.trim();
  state.employeeLookup = null;
  nameInput.value = "";

  if (!employeeNumber) {
    renderStatus();
    return;
  }

  const requestId = ++lookupRequestId;

  try {
    const response = await fetch(`${API_BASE}/eligible-voter?employeeNumber=${encodeURIComponent(employeeNumber)}`);
    const result = await response.json();

    if (requestId !== lookupRequestId) {
      return;
    }

    if (!response.ok) {
      setStatus(result.message || "등록된 사원번호만 투표할 수 있습니다.", "warning");
      return;
    }

    state.employeeLookup = result;
    nameInput.value = result.voterName;
    setStatus("1개에서 최대 3개 작품까지 선택한 뒤 투표를 제출해 주세요.");
  } catch (error) {
    if (requestId !== lookupRequestId) {
      return;
    }

    setStatus("사원번호를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.", "warning");
  }
}

async function submitVote() {
  try {
    await refreshMeta();
  } catch (error) {
    setStatus("서버 상태를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.", "warning");
    return;
  }

  if (state.submittedVote) {
    setStatus("최초 투표 완료 후에는 변경하거나 다시 투표할 수 없습니다.", "warning");
    return;
  }

  if (votingClosed) {
    setStatus("투표가 마감되어 더 이상 참여할 수 없습니다.", "warning");
    disableForm();
    return;
  }

  const employeeNumber = employeeNumberInput.value.trim();
  const videoIds = getSelectedVideoIds();

  if (!employeeNumber) {
    setStatus("사원번호를 입력해 주세요.", "warning");
    return;
  }

  if (!state.employeeLookup || state.employeeLookup.employeeNumber !== employeeNumber) {
    setStatus("등록된 사원번호만 투표할 수 있습니다.", "warning");
    return;
  }

  if (videoIds.length < 1 || videoIds.length > 3) {
    setStatus("투표 작품은 최소 1개에서 최대 3개까지 선택할 수 있습니다.", "warning");
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/vote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        employeeNumber,
        videoIds
      })
    });

    const result = await response.json();
    if (!response.ok) {
      setStatus(result.message || "투표 처리에 실패했습니다.", "warning");
      return;
    }

    state.submittedVote = {
      employeeNumber,
      voterName: result.voterName || nameInput.value,
      videoIds,
      submittedAt: result.submittedAt,
      resetVersion
    };
    state.employeeLookup = {
      employeeNumber,
      voterName: state.submittedVote.voterName
    };

    saveSubmittedVote();
    employeeNumberInput.value = state.submittedVote.employeeNumber;
    nameInput.value = state.submittedVote.voterName;
    applySelectedVideoIds(videoIds);
    renderStatus();
    toggleFormByVotingState();
  } catch (error) {
    setStatus("서버 통신 중 문제가 발생했습니다. 잠시 뒤 다시 시도해 주세요.", "warning");
  }
}

function renderVoteOptions() {
  selectedVideo.innerHTML = videos.map((video, index) => {
    return `
      <label class="vote-checkbox">
        <input type="checkbox" name="videoIds" value="${escapeHtml(video.id)}">
        <span class="vote-checkbox__text">${escapeHtml(`Entry ${String(index + 1).padStart(2, "0")} · ${video.title}`)}</span>
      </label>
    `;
  }).join("");
}

function enforceVoteSelectionLimit() {
  const checked = getCheckedInputs();
  if (checked.length <= 3) {
    return;
  }

  const lastChecked = checked[checked.length - 1];
  lastChecked.checked = false;
  setStatus("최대 3개 작품까지만 선택할 수 있습니다.", "warning");
}

function getCheckedInputs() {
  return Array.from(selectedVideo.querySelectorAll('input[type="checkbox"]:checked'));
}

function getSelectedVideoIds() {
  return getCheckedInputs().map((input) => input.value);
}

function applySelectedVideoIds(videoIds) {
  const selected = new Set(videoIds);
  selectedVideo.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function loadSubmittedVote() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (error) {
    return null;
  }
}

function saveSubmittedVote() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.submittedVote));
}

function syncStoredVoteWithResetVersion() {
  if (!state.submittedVote) {
    return;
  }

  if (state.submittedVote.resetVersion !== resetVersion) {
    state.submittedVote = null;
    state.employeeLookup = null;
    localStorage.removeItem(STORAGE_KEY);
  }
}

async function refreshMeta() {
  const response = await fetch(`${API_BASE}/meta`);
  if (!response.ok) {
    throw new Error("meta fetch failed");
  }

  const meta = await response.json();
  resetVersion = meta.resetVersion || 1;
  votingClosed = Boolean(meta.votingClosed);
  syncStoredVoteWithResetVersion();
  toggleFormByVotingState();
}

function renderVideoCards() {
  videoGrid.innerHTML = "";

  videos.forEach((video, index) => {
    const card = videoCardTemplate.content.firstElementChild.cloneNode(true);
    const media = card.querySelector(".video-card__media");
    const topline = card.querySelector(".video-card__topline");
    const title = card.querySelector("h3");
    const description = card.querySelector(".video-card__description");
    const link = card.querySelector("a");
    const moreButton = card.querySelector(".video-card__more");

    topline.textContent = `ENTRY ${String(index + 1).padStart(2, "0")} · YOUTUBE`;
    title.textContent = video.title;
    description.textContent = summarizeDescription(video.description || "YouTube 링크로 등록된 출품 영상입니다.");
    link.href = video.url;
    moreButton.addEventListener("click", () => openDescriptionModal(video));

    media.appendChild(createMediaElement(video));
    videoGrid.appendChild(card);
  });
}

function createMediaElement(video) {
  const youtubeId = getYoutubeId(video.url);

  if (video.type === "youtube" && youtubeId) {
    if (currentlyPlayingVideoId === video.id) {
      const iframe = document.createElement("iframe");
      iframe.src = `https://www.youtube.com/embed/${youtubeId}?autoplay=1&rel=0`;
      iframe.title = video.title;
      iframe.loading = "lazy";
      iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      iframe.allowFullscreen = true;
      return iframe;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "video-card__launch";
    button.style.backgroundImage = `linear-gradient(180deg, rgba(11, 17, 24, 0.14), rgba(11, 17, 24, 0.38)), url(https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg)`;
    button.setAttribute("aria-label", `${video.title} 재생`);
    button.addEventListener("click", () => {
      currentlyPlayingVideoId = video.id;
      renderVideoCards();
    });

    const badge = document.createElement("span");
    badge.className = "video-card__launch-badge";
    badge.textContent = "재생";
    button.appendChild(badge);

    return button;
  }

  const fallback = document.createElement("div");
  fallback.className = "video-card__placeholder";
  fallback.textContent = "미리보기를 지원하지 않는 링크입니다. 유튜브로 보기 버튼으로 확인해 주세요.";
  return fallback;
}

function getYoutubeId(url) {
  const match = String(url || "").match(/(?:youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/embed\/)([^?&/]+)/i);
  return match ? match[1] : null;
}

function summarizeDescription(text) {
  return text.length > 54 ? `${text.slice(0, 54)}...` : text;
}

function openDescriptionModal(video) {
  modalTitle.textContent = video.title;
  modalSubmitter.textContent = "";
  modalDescription.textContent = video.description || "상세 설명이 없습니다.";
  descriptionModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDescriptionModal() {
  descriptionModal.hidden = true;
  document.body.style.overflow = "";
}

function renderStatus() {
  if (state.submittedVote) {
    const selectedTitles = videos
      .filter((video) => (state.submittedVote.videoIds || []).includes(video.id))
      .map((video) => video.title);
    setStatus(
      `${state.submittedVote.voterName}님 투표가 저장되었습니다. 선택 작품: ${selectedTitles.join(", ")}`,
      "success"
    );
    return;
  }

  if (votingClosed) {
    setStatus("투표가 마감되었습니다.", "warning");
    return;
  }

  setStatus("1개에서 최대 3개 작품까지 선택한 뒤 최초 1회만 투표할 수 있습니다.");
}

function disableForm() {
  Array.from(form.elements).forEach((element) => {
    element.disabled = true;
  });
  nameInput.readOnly = true;
}

function enableForm() {
  Array.from(form.elements).forEach((element) => {
    element.disabled = false;
  });
  employeeNumberInput.disabled = false;
  employeeNumberInput.readOnly = false;
  nameInput.disabled = true;
  nameInput.readOnly = true;
}

function toggleFormByVotingState() {
  if (state.submittedVote || votingClosed) {
    disableForm();
    return;
  }

  enableForm();
}

function setStatus(message, tone = "") {
  voteStatus.textContent = message;
  voteStatus.className = "status-card";

  if (tone === "success") {
    voteStatus.classList.add("is-success");
  }

  if (tone === "warning") {
    voteStatus.classList.add("is-warning");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
