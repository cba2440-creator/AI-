const API_BASE = "/api";
const META_REFRESH_INTERVAL = 15000;

let videos = [];
let votingClosed = false;
let currentlyPlayingVideoId = null;
let verificationTimer = null;
let lookupRequestId = 0;

const form = document.querySelector("#vote-form");
const employeeNumberInput = document.querySelector("#employee-number");
const employeePasswordInput = document.querySelector("#employee-password");
const nameInput = document.querySelector("#voter-name");
const voteSelects = Array.from(document.querySelectorAll(".vote-select"));
const submitButton = document.querySelector("#submit-button");
const voteStatus = document.querySelector("#vote-status");
const voteToast = document.querySelector("#vote-toast");
const videoGrid = document.querySelector("#video-grid");
const videoCardTemplate = document.querySelector("#video-card-template");
const descriptionModal = document.querySelector("#description-modal");
const modalCloseButton = document.querySelector("#modal-close");
const modalTitle = document.querySelector("#modal-title");
const modalDescription = document.querySelector("#modal-description");

const state = {
  verifiedVoter: null
};

initialize();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitVote();
});

employeeNumberInput.addEventListener("input", handleCredentialInput);
employeePasswordInput.addEventListener("input", handleCredentialInput);

[employeeNumberInput, employeePasswordInput, ...voteSelects].forEach((element, index, elements) => {
  element.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();

    if (element === employeePasswordInput) {
      const verified = await verifyVoter();
      if (!verified) {
        return;
      }
    }

    const nextElement = elements[index + 1];
    if (nextElement) {
      nextElement.focus();
      if ("select" in nextElement && typeof nextElement.select === "function") {
        nextElement.select();
      }
      return;
    }

    if (!submitButton.disabled) {
      submitButton.focus();
    }
  });
});

voteSelects.forEach((select) => {
  select.addEventListener("change", () => enforceUniqueSelections(select));
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

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshMetaState();
  }
});

async function initialize() {
  try {
    const [videosResponse, metaResponse] = await Promise.all([
      fetch(`${API_BASE}/videos`),
      fetch(`${API_BASE}/meta`)
    ]);

    if (!videosResponse.ok || !metaResponse.ok) {
      throw new Error("Failed to load initial data");
    }

    videos = await videosResponse.json();
    const meta = await metaResponse.json();
    votingClosed = Boolean(meta.votingClosed);

    renderVoteOptions();
    renderVideoCards();
    renderStatus();
    updateFormAvailability();
    window.setInterval(refreshMetaState, META_REFRESH_INTERVAL);
  } catch (error) {
    showToast("페이지 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", "warning");
  }
}

function handleCredentialInput() {
  const previousKey = state.verifiedVoter ? buildCredentialKey(state.verifiedVoter.employeeNumber, state.verifiedVoter.password) : "";
  const nextKey = buildCredentialKey(employeeNumberInput.value, employeePasswordInput.value);

  if (previousKey !== nextKey) {
    state.verifiedVoter = null;
    nameInput.value = "";
  }

  renderStatus();
  updateFormAvailability();
  window.clearTimeout(verificationTimer);

  if (!employeeNumberInput.value.trim() || !employeePasswordInput.value.trim()) {
    return;
  }

  verificationTimer = window.setTimeout(() => {
    verifyVoter();
  }, 250);
}

async function verifyVoter() {
  const employeeNumber = employeeNumberInput.value.trim();
  const password = employeePasswordInput.value.trim();

  if (!employeeNumber || !password) {
    return false;
  }

  const currentKey = buildCredentialKey(employeeNumber, password);
  const verifiedKey = state.verifiedVoter
    ? buildCredentialKey(state.verifiedVoter.employeeNumber, state.verifiedVoter.password)
    : "";

  if (currentKey === verifiedKey) {
    return true;
  }

  const requestId = ++lookupRequestId;

  try {
    const response = await fetch(
      `${API_BASE}/eligible-voter?employeeNumber=${encodeURIComponent(employeeNumber)}&password=${encodeURIComponent(password)}`
    );
    const result = await response.json();

    if (requestId !== lookupRequestId) {
      return false;
    }

    if (!response.ok) {
      state.verifiedVoter = null;
      nameInput.value = "";
      renderStatus();
      updateFormAvailability();
      showToast(result.message || "사원번호 또는 비밀번호를 다시 확인해 주세요.", "warning");
      return false;
    }

    state.verifiedVoter = {
      employeeNumber,
      password,
      voterName: result.voterName,
      hasVoted: Boolean(result.hasVoted),
      videoIds: Array.isArray(result.videoIds) ? result.videoIds : []
    };

    nameInput.value = result.voterName;
    applySelectedVideoIds(result.videoIds || []);
    renderStatus();
    updateFormAvailability();
    return true;
  } catch (error) {
    if (requestId !== lookupRequestId) {
      return false;
    }

    showToast("본인 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", "warning");
    return false;
  }
}

async function submitVote() {
  await refreshMetaState();

  if (votingClosed) {
    renderStatus();
    updateFormAvailability();
    showToast("투표가 마감되었습니다.", "warning");
    return;
  }

  const verified = await verifyVoter();
  if (!verified) {
    return;
  }

  if (state.verifiedVoter.hasVoted) {
    renderStatus();
    updateFormAvailability();
    showToast("이미 투표가 완료된 계정입니다. 제출 후에는 내용을 변경할 수 없습니다.", "warning");
    return;
  }

  const videoIds = getSelectedVideoIds();
  if (videoIds.length < 1 || videoIds.length > 3) {
    showToast("최소 1개에서 최대 3개 작품까지 선택해 주세요.", "warning");
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/vote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        employeeNumber: state.verifiedVoter.employeeNumber,
        password: state.verifiedVoter.password,
        videoIds
      })
    });

    const result = await response.json();

    if (!response.ok) {
      if (response.status === 409) {
        state.verifiedVoter.hasVoted = true;
      }
      renderStatus();
      updateFormAvailability();
      showToast(result.message || "투표 제출에 실패했습니다.", "warning");
      return;
    }

    state.verifiedVoter.hasVoted = true;
    state.verifiedVoter.videoIds = videoIds;
    applySelectedVideoIds(videoIds);
    renderStatus();
    updateFormAvailability();
    showToast("투표가 완료되었습니다. 최초 제출 후에는 내용을 변경할 수 없습니다.", "success");
  } catch (error) {
    showToast("서버와 통신하는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.", "warning");
  }
}

function renderVoteOptions() {
  const options = [
    { value: "", label: "없음" },
    ...videos.map((video, index) => ({
      value: video.id,
      label: `${String(index + 1).padStart(2, "0")} · ${stripLeadingNumber(video.title)}`
    }))
  ];

  voteSelects.forEach((select) => {
    select.innerHTML = options
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join("");
  });
}

function enforceUniqueSelections(changedSelect) {
  const value = changedSelect.value;
  if (!value) {
    return;
  }

  voteSelects.forEach((select) => {
    if (select !== changedSelect && select.value === value) {
      select.value = "";
    }
  });
}

function getSelectedVideoIds() {
  return [...new Set(voteSelects.map((select) => select.value).filter(Boolean))];
}

function applySelectedVideoIds(videoIds) {
  voteSelects.forEach((select, index) => {
    select.value = videoIds[index] || "";
  });
}

function renderVideoCards() {
  videoGrid.innerHTML = "";

  videos.forEach((video, index) => {
    const card = videoCardTemplate.content.firstElementChild.cloneNode(true);
    const media = card.querySelector(".video-card__media");
    const indexBadge = card.querySelector(".video-card__index-badge");
    const topline = card.querySelector(".video-card__topline");
    const title = card.querySelector("h3");
    const description = card.querySelector(".video-card__description");
    const link = card.querySelector("a");
    const moreButton = card.querySelector(".video-card__more");

    indexBadge.textContent = String(index + 1);
    indexBadge.classList.toggle("is-hidden", currentlyPlayingVideoId === video.id);
    topline.textContent = `ENTRY ${String(index + 1).padStart(2, "0")} · YOUTUBE`;
    title.textContent = stripLeadingNumber(video.title);
    description.textContent = summarizeDescription(video.description || "YouTube 링크로 등록된 출품 영상입니다.");
    link.href = video.url;
    moreButton.addEventListener("click", () => openDescriptionModal(video));

    media.appendChild(createMediaElement(video));
    videoGrid.appendChild(card);
  });
}

function createMediaElement(video) {
  if (video.localVideoUrl) {
    const videoElement = document.createElement("video");
    videoElement.src = video.localVideoUrl;
    videoElement.controls = true;
    videoElement.preload = "metadata";
    videoElement.playsInline = true;
    videoElement.setAttribute("controlsList", "nodownload");
    return videoElement;
  }

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
  modalTitle.textContent = stripLeadingNumber(video.title);
  modalDescription.textContent = video.description || "상세 설명이 없습니다.";
  descriptionModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDescriptionModal() {
  descriptionModal.hidden = true;
  document.body.style.overflow = "";
}

function renderStatus() {
  voteStatus.className = "status-card status-card--centered";

  if (votingClosed) {
    voteStatus.textContent = "투표가 마감되었습니다";
    voteStatus.classList.add("is-warning");
    return;
  }

  if (state.verifiedVoter?.hasVoted) {
    voteStatus.textContent = "투표가 완료되었습니다";
    voteStatus.classList.add("is-success");
    return;
  }

  voteStatus.textContent = "투표 바랍니다";
}

async function refreshMetaState() {
  try {
    const metaResponse = await fetch(`${API_BASE}/meta`);
    if (!metaResponse.ok) {
      return;
    }

    const meta = await metaResponse.json();
    const nextVotingClosed = Boolean(meta.votingClosed);

    if (nextVotingClosed !== votingClosed) {
      votingClosed = nextVotingClosed;
      renderStatus();
      updateFormAvailability();
    } else {
      votingClosed = nextVotingClosed;
    }
  } catch {}
}

function updateFormAvailability() {
  const canVote = Boolean(state.verifiedVoter) && !state.verifiedVoter.hasVoted && !votingClosed;

  voteSelects.forEach((select) => {
    select.disabled = !canVote;
  });
  submitButton.disabled = !canVote;
  nameInput.disabled = false;
  nameInput.readOnly = true;
}

function showToast(message, tone = "default") {
  voteToast.textContent = message;
  voteToast.className = "admin-toast is-visible";

  if (tone === "warning") {
    voteToast.classList.add("admin-toast--warning");
  }

  if (tone === "success") {
    voteToast.classList.add("admin-toast--success");
  }

  window.clearTimeout(showToast.timerId);
  showToast.timerId = window.setTimeout(() => {
    voteToast.className = "admin-toast";
  }, 2600);
}

function buildCredentialKey(employeeNumber, password) {
  return `${String(employeeNumber || "").trim()}::${String(password || "").trim()}`;
}

function stripLeadingNumber(title) {
  return String(title || "").replace(/^\d+\.\s*/, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
