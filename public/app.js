const API_ORIGIN = "";
const API_BASE = `${API_ORIGIN}/api`;
const META_REFRESH_INTERVAL = 15000;

const CONTEST_CONFIG = {
  video: {
    badge: "2026 AI Video Contest",
    title: "2026 AI Video Contest",
    description: "가장 인상 깊은 작품에 소중한 한 표를 남겨 주세요.",
    listTitle: "출품 작품",
    voteLabel: "투표 작품 선택",
    optionLabel: "영상",
    voteMethod: "1인 1표"
  },
  bgm: {
    badge: "2026 AI Music Contest",
    title: "2026 AI Music Contest",
    description: "투표 부탁드립니다.",
    listTitle: "출품 음악",
    voteLabel: "카테고리별 투표 선택",
    optionLabel: "",
    voteMethod: "카테고리별 1표"
  }
};

const form = document.querySelector("#vote-form");
const employeeNumberInput = document.querySelector("#employee-number");
const employeePasswordInput = document.querySelector("#employee-password");
const nameInput = document.querySelector("#voter-name");
const voteSelectContainer = document.querySelector("#selected-video");
const submitButton = document.querySelector("#submit-button");
const voteStatus = document.querySelector("#vote-status");
const voteToast = document.querySelector("#vote-toast");
const videoGrid = document.querySelector("#video-grid");
const videoCardTemplate = document.querySelector("#video-card-template");
const descriptionModal = document.querySelector("#description-modal");
const modalCloseButton = document.querySelector("#modal-close");
const modalTitle = document.querySelector("#modal-title");
const modalSubmitter = document.querySelector("#modal-submitter");
const modalDescription = document.querySelector("#modal-description");
const contestBadge = document.querySelector("#contest-badge");
const contestTitle = document.querySelector("#contest-title");
const contestDescription = document.querySelector("#contest-description");
const contestListTitle = document.querySelector("#contest-list-title");
const voteSelectLabel = document.querySelector("#vote-select-label");
const voteMethodText = document.querySelectorAll(".hero__meta strong")[1] || null;
const musicCategoryNav = document.querySelector("#music-category-nav");

const state = {
  videos: [],
  votingClosed: false,
  activeContestType: "video",
  musicCategories: [],
  selectedMusicCategory: "",
  verifiedVoter: null,
  lastVerifiedKey: "",
  currentlyPlayingId: null,
  pendingAutoplayId: null,
  playbackSnapshot: {
    id: null,
    currentTime: 0,
    shouldResume: false
  },
  verificationTimer: null,
  lookupRequestId: 0
};

initialize();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitVote();
});

employeeNumberInput.addEventListener("input", handleCredentialInput);
employeePasswordInput.addEventListener("input", handleCredentialInput);
employeeNumberInput.addEventListener("keydown", handleFieldEnter);
employeePasswordInput.addEventListener("keydown", handleFieldEnter);

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
      fetch(`${API_BASE}/meta?contestType=${encodeURIComponent(state.activeContestType)}`)
    ]);

    if (!videosResponse.ok || !metaResponse.ok) {
      throw new Error("Failed to load initial data");
    }

    state.videos = await videosResponse.json();
    const meta = await metaResponse.json();
    state.activeContestType = meta.publicContestType || state.activeContestType;
    state.musicCategories = Array.isArray(meta.musicCategories) ? meta.musicCategories : [];

    await refreshMetaState();
    applyContestTheme();
    renderVoteOptions();
    renderVideoCards();
    renderStatus();
    updateFormAvailability();
    window.setInterval(refreshMetaState, META_REFRESH_INTERVAL);
  } catch {
    showToast("페이지 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", "warning");
  }
}

function getContestConfig() {
  return CONTEST_CONFIG[state.activeContestType] || CONTEST_CONFIG.video;
}

function getVisibleVideos() {
  return state.videos.filter((video) => (video.contestType || "video") === state.activeContestType);
}

function getMusicCategories() {
  const categories = state.musicCategories.filter(Boolean);
  if (categories.length) {
    return categories;
  }

  return [...new Set(
    getVisibleVideos()
      .map((video) => String(video.musicCategory || "").trim())
      .filter(Boolean)
  )];
}

function ensureSelectedMusicCategory() {
  const categories = getMusicCategories();
  if (!categories.length) {
    state.selectedMusicCategory = "";
    return;
  }

  if (!categories.includes(state.selectedMusicCategory)) {
    state.selectedMusicCategory = categories[0];
  }
}

function getCurrentVoteState() {
  if (!state.verifiedVoter) {
    return { hasVoted: false, videoIds: [], selectionsByCategory: {}, submittedAt: null };
  }

  return state.verifiedVoter.votesByContestType?.[state.activeContestType] || {
    hasVoted: false,
    videoIds: [],
    selectionsByCategory: {},
    submittedAt: null
  };
}

function applyContestTheme() {
  const config = getContestConfig();
  contestBadge.textContent = config.badge;
  contestTitle.textContent = config.title;
  contestDescription.textContent = config.description;
  contestListTitle.textContent = config.listTitle;
  voteSelectLabel.textContent = config.voteLabel;

  if (voteMethodText) {
    voteMethodText.textContent = config.voteMethod;
  }
}

function handleCredentialInput() {
  const previousKey = state.verifiedVoter
    ? buildCredentialKey(state.verifiedVoter.employeeNumber, state.verifiedVoter.password)
    : "";
  const nextKey = buildCredentialKey(employeeNumberInput.value, employeePasswordInput.value);

  if (previousKey !== nextKey) {
    state.verifiedVoter = null;
    state.lastVerifiedKey = "";
    state.currentlyPlayingId = null;
    nameInput.value = "";
    renderVideoCards();
  }

  renderStatus();
  updateFormAvailability();
  window.clearTimeout(state.verificationTimer);

  if (!employeeNumberInput.value.trim() || !employeePasswordInput.value.trim()) {
    return;
  }

  state.verificationTimer = window.setTimeout(() => {
    verifyVoter();
  }, 250);
}

async function handleFieldEnter(event) {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();

  if (event.currentTarget === employeePasswordInput) {
    const verified = await verifyVoter();
    if (!verified) {
      return;
    }
  }

  moveFocusToNextField(event.currentTarget);
}

function moveFocusToNextField(currentField) {
  const fields = [employeeNumberInput, employeePasswordInput, ...getVoteSelectElements()];
  const currentIndex = fields.indexOf(currentField);
  const nextField = fields[currentIndex + 1];

  if (nextField) {
    nextField.focus();
    return;
  }

  if (!submitButton.disabled) {
    submitButton.focus();
  }
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
  const shouldAnnounceVerification = state.lastVerifiedKey !== currentKey || verifiedKey !== currentKey;
  const requestId = ++state.lookupRequestId;

  try {
    const response = await fetch(`${API_BASE}/eligible-voter`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        employeeNumber,
        password,
        contestType: state.activeContestType
      })
    });
    const result = await response.json();

    if (requestId !== state.lookupRequestId) {
      return false;
    }

    if (!response.ok) {
      state.verifiedVoter = null;
      state.lastVerifiedKey = "";
      nameInput.value = "";
      renderVideoCards();
      renderStatus();
      updateFormAvailability();
      showToast("사원번호 또는 비밀번호를 다시 확인해 주세요.", "warning");
      return false;
    }

    state.verifiedVoter = {
      employeeNumber,
      password,
      voterName: result.voterName,
      votesByContestType: result.votesByContestType || {
        [state.activeContestType]: {
          hasVoted: Boolean(result.hasVoted),
          videoIds: Array.isArray(result.videoIds) ? result.videoIds : [],
          selectionsByCategory: result.selectionsByCategory || {},
          submittedAt: result.submittedAt || null
        }
      }
    };

    state.lastVerifiedKey = currentKey;
    nameInput.value = result.voterName;
    applySelectedVoteState(getCurrentVoteState());
    renderVideoCards();
    renderStatus();
    updateFormAvailability();

    if (shouldAnnounceVerification) {
      showToast("인증되었습니다.", "success");
    }

    return true;
  } catch {
    if (requestId !== state.lookupRequestId) {
      return false;
    }

    state.verifiedVoter = null;
    state.lastVerifiedKey = "";
    nameInput.value = "";
    renderVideoCards();
    renderStatus();
    updateFormAvailability();
    showToast("본인 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", "warning");
    return false;
  }
}

async function submitVote() {
  const preservedVoteState = getPreparedVoteState();
  if (!preservedVoteState) {
    return;
  }

  await refreshMetaState();

  if (state.votingClosed) {
    renderStatus();
    updateFormAvailability();
    showToast("현재 콘테스트 투표가 마감되었습니다.", "warning");
    return;
  }

  const verified = await verifyVoter();
  if (!verified) {
    return;
  }

  applySelectedVoteState(preservedVoteState);

  const currentVoteState = getCurrentVoteState();
  if (currentVoteState.hasVoted) {
    renderStatus();
    updateFormAvailability();
    showToast("이미 투표를 완료했습니다.", "warning");
    return;
  }

  const payload = getPreparedVoteState();
  if (!payload) {
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
        contestType: state.activeContestType,
        videoIds: payload.videoIds,
        selectionsByCategory: payload.selectionsByCategory
      })
    });
    const result = await response.json();

    if (!response.ok) {
      if (response.status === 409 && state.verifiedVoter?.votesByContestType?.[state.activeContestType]) {
        state.verifiedVoter.votesByContestType[state.activeContestType].hasVoted = true;
      }
      renderStatus();
      updateFormAvailability();
      if (response.status === 409) {
        showToast("이미 투표를 완료했습니다.", "warning");
      } else if (response.status === 403 && state.votingClosed) {
        showToast("현재 콘테스트 투표가 마감되었습니다.", "warning");
      } else {
        showToast(result.message || "투표 제출에 실패했습니다. 다시 시도해 주세요.", "warning");
      }
      return;
    }

    state.verifiedVoter.votesByContestType[state.activeContestType] = {
      hasVoted: true,
      videoIds: payload.videoIds,
      selectionsByCategory: payload.selectionsByCategory,
      submittedAt: result.submittedAt || new Date().toISOString()
    };

    applySelectedVoteState(state.verifiedVoter.votesByContestType[state.activeContestType]);
    renderStatus();
    updateFormAvailability();
    showToast("투표가 완료되었습니다.", "success");
  } catch {
    showToast("서버 통신 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.", "warning");
  }
}

function renderVoteOptions() {
  const visibleVideos = getVisibleVideos();
  const currentVoteState = getCurrentVoteState();
  voteSelectContainer.innerHTML = "";

  if (state.activeContestType === "bgm") {
    const categories = getMusicCategories();
    const preservedSelections = currentVoteState.selectionsByCategory || {};

    categories.forEach((category) => {
      const row = document.createElement("div");
      row.className = "vote-select-row";

      const label = document.createElement("div");
      label.className = "vote-select-row__label";
      label.textContent = category;

      const select = document.createElement("select");
      select.className = "vote-select";
      select.dataset.category = category;
      select.setAttribute("aria-label", `${category} 투표 음악 선택`);
      select.innerHTML = [
        `<option value="">${escapeHtml(`${category} 선택`)}</option>`,
        ...visibleVideos
          .filter((video) => String(video.musicCategory || "").trim() === category)
          .map((video, index) => (
            `<option value="${escapeHtml(video.id)}">${escapeHtml(buildVoteOptionLabel(index, stripLeadingNumber(video.title), ""))}</option>`
          ))
      ].join("");
      select.value = preservedSelections[category] || "";
      select.addEventListener("keydown", handleDynamicSelectEnter);

      row.append(label, select);
      voteSelectContainer.appendChild(row);
    });
  } else {
    const select = document.createElement("select");
    select.id = "selected-video-1";
    select.className = "vote-select";
    select.setAttribute("aria-label", "투표 작품");
    select.innerHTML = [
      '<option value="">선택해 주세요</option>',
      ...visibleVideos.map((video, index) => (
        `<option value="${escapeHtml(video.id)}">${escapeHtml(buildVoteOptionLabel(index, stripLeadingNumber(video.title), getContestConfig().optionLabel))}</option>`
      ))
    ].join("");
    select.value = currentVoteState.videoIds?.[0] || "";
    select.addEventListener("keydown", handleDynamicSelectEnter);
    voteSelectContainer.appendChild(select);
  }
}

function handleDynamicSelectEnter(event) {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  moveFocusToNextField(event.currentTarget);
}

function getVoteSelectElements() {
  return Array.from(voteSelectContainer.querySelectorAll(".vote-select"));
}

function getPreparedVoteState() {
  if (state.activeContestType === "bgm") {
    const categories = getMusicCategories();
    const selectionsByCategory = Object.fromEntries(
      getVoteSelectElements().map((select) => [select.dataset.category || "", select.value]).filter(([category]) => category)
    );

    if (!categories.length) {
      showToast("AI Music 카테고리가 아직 준비되지 않았습니다.", "warning");
      return null;
    }

    if (categories.some((category) => !selectionsByCategory[category])) {
      showToast("모든 카테고리에서 1곡씩 선택해 주세요.", "warning");
      return null;
    }

    return {
      videoIds: categories.map((category) => selectionsByCategory[category]),
      selectionsByCategory
    };
  }

  const selectedId = getVoteSelectElements()[0]?.value || "";
  if (!selectedId) {
    showToast("투표 작품 1개를 선택해 주세요.", "warning");
    return null;
  }

  return {
    videoIds: [selectedId],
    selectionsByCategory: {}
  };
}

function applySelectedVoteState(voteState) {
  const current = voteState || { videoIds: [], selectionsByCategory: {} };

  if (state.activeContestType === "bgm") {
    const selections = current.selectionsByCategory || {};
    getVoteSelectElements().forEach((select) => {
      const category = select.dataset.category || "";
      select.value = selections[category] || "";
    });
    return;
  }

  const firstSelect = getVoteSelectElements()[0];
  if (firstSelect) {
    firstSelect.value = current.videoIds?.[0] || "";
  }
}

function renderVideoCards() {
  capturePlaybackSnapshot();
  videoGrid.innerHTML = "";
  const visibleVideos = getVisibleVideos();
  const hasAccess = Boolean(state.verifiedVoter);

  if (!visibleVideos.length) {
    videoGrid.innerHTML = '<div class="admin-vote-empty">등록된 출품작이 없습니다.</div>';
    return;
  }

  if (state.activeContestType === "bgm") {
    const category = state.selectedMusicCategory;
    const categoryVideos = visibleVideos.filter((video) => String(video.musicCategory || "").trim() === category);

    if (!categoryVideos.length) {
      videoGrid.innerHTML = '<div class="admin-vote-empty">선택한 카테고리의 출품곡이 없습니다.</div>';
      return;
    }

    const section = document.createElement("section");
    section.className = "category-shelf";

    const heading = document.createElement("div");
    heading.className = "category-shelf__title";
    heading.textContent = category;

    const groupGrid = document.createElement("div");
    groupGrid.className = "video-grid video-grid--category";

    categoryVideos.forEach((video, index) => {
      groupGrid.appendChild(buildVideoCard(video, index, hasAccess));
    });

    section.append(heading, groupGrid);
    videoGrid.appendChild(section);
    return;
  }

  visibleVideos.forEach((video, index) => {
    videoGrid.appendChild(buildVideoCard(video, index, hasAccess));
  });
}

function renderMusicCategoryNav() {
  if (!musicCategoryNav) {
    return;
  }

  if (state.activeContestType !== "bgm") {
    musicCategoryNav.hidden = true;
    musicCategoryNav.innerHTML = "";
    return;
  }

  const categories = getMusicCategories();
  ensureSelectedMusicCategory();
  musicCategoryNav.hidden = categories.length === 0;

  musicCategoryNav.innerHTML = categories.map((category) => `
    <button
      type="button"
      class="music-category-nav__button${category === state.selectedMusicCategory ? " is-active" : ""}"
      data-category="${escapeHtml(category)}"
    >${escapeHtml(category)}</button>
  `).join("");

  musicCategoryNav.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedMusicCategory = button.dataset.category || "";
      renderMusicCategoryNav();
      renderVideoCards();
    });
  });
}

function buildVideoCard(video, index, hasAccess) {
  const card = videoCardTemplate.content.firstElementChild.cloneNode(true);
  const media = card.querySelector(".video-card__media");
  const indexBadge = card.querySelector(".video-card__index-badge");
  const topline = card.querySelector(".video-card__topline");
  const title = card.querySelector("h3");
  const description = card.querySelector(".video-card__description");
  const moreButton = card.querySelector(".video-card__more");

  card.classList.toggle("is-playing", state.currentlyPlayingId === video.id);
  card.classList.toggle("is-locked", !hasAccess);
  media.classList.toggle("video-card__media--audio", video.contestType === "bgm");
  indexBadge.textContent = String(index + 1);
  topline.textContent =
    video.contestType === "bgm"
      ? `ENTRY ${String(index + 1).padStart(2, "0")}`
      : `${state.activeContestType.toUpperCase()} ENTRY ${String(index + 1).padStart(2, "0")}`;

  title.textContent = stripLeadingNumber(video.title);
  description.textContent = summarizeText(video.description || "설명이 아직 등록되지 않았습니다.", 90);

  moreButton.addEventListener("click", () => openDescriptionModal(video));
  media.appendChild(createMediaElement(video));

  if (state.pendingAutoplayId === video.id || state.playbackSnapshot.id === video.id) {
    requestAnimationFrame(() => {
      const mediaElement = card.querySelector("audio, video");
      if (!mediaElement) {
        return;
      }

      restorePlaybackSnapshot(mediaElement, video.id);

      if ((state.pendingAutoplayId === video.id || state.playbackSnapshot.shouldResume) && typeof mediaElement.play === "function") {
        mediaElement.play().catch(() => {});
      }
    });
    state.pendingAutoplayId = null;
  }

  return card;
}

function createMediaElement(video) {
  if (video.contestType === "bgm") {
    if (!video.localVideoUrl) {
      const placeholder = document.createElement("div");
      placeholder.className = "video-card__launch video-card__launch--audio";
      placeholder.textContent = "음원 준비중";
      return placeholder;
    }

    if (state.currentlyPlayingId === video.id) {
      const audio = document.createElement("audio");
      audio.src = resolveMediaUrl(video.localVideoUrl);
      audio.controls = true;
      audio.preload = "metadata";
      return audio;
    }

    return createLaunchButton(video, "재생");
  }

  if (video.localVideoUrl) {
    if (state.currentlyPlayingId === video.id) {
      const player = document.createElement("video");
      player.src = resolveMediaUrl(video.localVideoUrl);
      player.controls = true;
      player.preload = "metadata";
      player.playsInline = true;
      player.setAttribute("controlsList", "nodownload");
      return player;
    }

    return createLaunchButton(video, "재생");
  }

  const youtubeId = getYoutubeId(video.url);
  const backgroundImage = youtubeId
    ? `linear-gradient(180deg, rgba(11, 17, 24, 0.14), rgba(11, 17, 24, 0.38)), url(https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg)`
    : "linear-gradient(180deg, rgba(11, 17, 24, 0.36), rgba(11, 17, 24, 0.56))";

  return createExternalVideoButton(video, backgroundImage);
}

function createLaunchButton(video, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "video-card__launch";
  if (video.contestType === "bgm") {
    button.classList.add("video-card__launch--audio");
  }
  button.textContent = label;
  button.setAttribute("aria-label", `${video.title} 재생`);
  button.addEventListener("click", async () => {
    const canAccess = await ensureMediaAccess();
    if (!canAccess) {
      return;
    }
    state.currentlyPlayingId = video.id;
    state.pendingAutoplayId = video.id;
    renderVideoCards();
  });
  return button;
}

function createExternalVideoButton(video, backgroundImage) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "video-card__launch video-card__launch--external";
  button.style.backgroundImage = backgroundImage;
  button.setAttribute("aria-label", `${video.title} 보기`);
  button.addEventListener("click", async () => {
    const canAccess = await ensureMediaAccess();
    if (!canAccess || !video.url) {
      return;
    }
    window.open(video.url, "_blank", "noopener,noreferrer");
  });
  return button;
}

function getYoutubeId(url) {
  const rawUrl = String(url || "").trim();
  if (!rawUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(rawUrl);
    const host = parsedUrl.hostname.replace(/^www\./i, "");
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);

    if (host === "youtu.be" && pathParts[0]) {
      return pathParts[0];
    }

    if (host === "youtube.com" || host === "m.youtube.com") {
      if (parsedUrl.pathname === "/watch") {
        return parsedUrl.searchParams.get("v");
      }

      if ((pathParts[0] === "embed" || pathParts[0] === "shorts") && pathParts[1]) {
        return pathParts[1];
      }
    }
  } catch {}

  const match = rawUrl.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^?&/]+)/i);
  return match ? match[1] : null;
}

function summarizeText(text, limit) {
  const normalized = String(text || "").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function resolveMediaUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  if (/^https?:\/\//i.test(rawValue)) {
    return rawValue;
  }

  return API_ORIGIN ? `${API_ORIGIN}${rawValue}` : rawValue;
}

function openDescriptionModal(video) {
  modalTitle.textContent = stripLeadingNumber(video.title);
  modalSubmitter.textContent = "";
  modalDescription.innerHTML = buildModalDescription(video);
  descriptionModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function buildModalDescription(video) {
  const categorySection = video.contestType === "bgm" && video.musicCategory
    ? `
      <section class="modal__section">
        <h3 class="modal__section-title">카테고리</h3>
        <div class="modal__section-body">${escapeHtml(video.musicCategory)}</div>
      </section>
    `
    : "";

  return `
    ${categorySection}
    <section class="modal__section">
      <h3 class="modal__section-title">설명</h3>
      <div class="modal__section-body">${escapeHtml(video.description || "설명이 등록되지 않았습니다.").replace(/\n/g, "<br>")}</div>
    </section>
  `;
}

function closeDescriptionModal() {
  descriptionModal.hidden = true;
  document.body.style.overflow = "";
}

function renderStatus() {
  voteStatus.className = "status-card status-card--centered";
  const currentVoteState = getCurrentVoteState();

  if (state.votingClosed) {
    voteStatus.textContent = "현재 콘테스트 투표가 마감되었습니다.";
    voteStatus.classList.add("is-warning");
    return;
  }

  if (currentVoteState.hasVoted) {
    voteStatus.textContent = "이미 투표를 완료했습니다.";
    voteStatus.classList.add("is-success");
    return;
  }

  voteStatus.textContent = "투표 참여 가능";
}

async function refreshMetaState() {
  try {
    const response = await fetch(`${API_BASE}/meta?contestType=${encodeURIComponent(state.activeContestType)}`);
    if (!response.ok) {
      return;
    }

    const meta = await response.json();
    const previousContestType = state.activeContestType;
    state.activeContestType = meta.publicContestType || state.activeContestType;
    state.musicCategories = Array.isArray(meta.musicCategories) ? meta.musicCategories : [];
    ensureSelectedMusicCategory();
    state.votingClosed = Boolean(meta.votingClosed);
    applyContestTheme();
    renderVoteOptions();
    renderMusicCategoryNav();
    if (previousContestType !== state.activeContestType) {
      state.currentlyPlayingId = null;
      state.playbackSnapshot = {
        id: null,
        currentTime: 0,
        shouldResume: false
      };
      ensureSelectedMusicCategory();
      renderVideoCards();
    }
    renderStatus();
    updateFormAvailability();
  } catch {}
}

async function ensureMediaAccess() {
  const employeeNumber = employeeNumberInput.value.trim();
  const password = employeePasswordInput.value.trim();

  if (!employeeNumber || !password) {
    showToast("사원번호와 비밀번호를 먼저 입력해 주세요.", "warning");
    if (!employeeNumber) {
      employeeNumberInput.focus();
    } else {
      employeePasswordInput.focus();
    }
    return false;
  }

  const verified = await verifyVoter();
  if (!verified) {
    showToast("사원번호와 비밀번호를 먼저 확인해 주세요.", "warning");
    return false;
  }

  return true;
}

function updateFormAvailability() {
  const canVote = Boolean(state.verifiedVoter) && !getCurrentVoteState().hasVoted && !state.votingClosed;

  getVoteSelectElements().forEach((select) => {
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

function buildVoteOptionLabel(index, title, optionLabel) {
  const numberLabel = `${String(index + 1).padStart(2, "0")}.`;
  const typeLabel = String(optionLabel || "").trim();
  return typeLabel ? `${numberLabel} ${typeLabel} ${title}` : `${numberLabel} ${title}`;
}

function capturePlaybackSnapshot() {
  if (!state.currentlyPlayingId) {
    state.playbackSnapshot = {
      id: null,
      currentTime: 0,
      shouldResume: false
    };
    return;
  }

  const activeMedia = videoGrid.querySelector("audio, video");
  if (!activeMedia) {
    return;
  }

  state.playbackSnapshot = {
    id: state.currentlyPlayingId,
    currentTime: Number.isFinite(activeMedia.currentTime) ? activeMedia.currentTime : 0,
    shouldResume: !activeMedia.paused
  };
}

function restorePlaybackSnapshot(mediaElement, videoId) {
  if (state.playbackSnapshot.id !== videoId) {
    return;
  }

  const targetTime = state.playbackSnapshot.currentTime;
  if (!(targetTime > 0)) {
    return;
  }

  const applyTime = () => {
    try {
      mediaElement.currentTime = targetTime;
    } catch {}
  };

  if (mediaElement.readyState >= 1) {
    applyTime();
    return;
  }

  mediaElement.addEventListener("loadedmetadata", applyTime, { once: true });
}
