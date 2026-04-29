export const DEFAULT_CONTEST_TYPE = "video";

export const CONTEST_TYPES = [
  { id: "video", label: "영상 콘테스트" },
  { id: "bgm", label: "AI Music Contest" }
];

const CONTEST_TYPE_IDS = new Set(CONTEST_TYPES.map((item) => item.id));

export function sanitizeText(value) {
  return String(value ?? "").trim();
}

export function normalizeContestType(value) {
  const normalized = sanitizeText(value).toLowerCase();
  return CONTEST_TYPE_IDS.has(normalized) ? normalized : DEFAULT_CONTEST_TYPE;
}

export function getContestTypes() {
  return CONTEST_TYPES.map((item) => ({ ...item }));
}

export function getContestLabel(contestType) {
  const normalized = normalizeContestType(contestType);
  return CONTEST_TYPES.find((item) => item.id === normalized)?.label || CONTEST_TYPES[0].label;
}

export function buildDefaultVotingClosedState() {
  return Object.fromEntries(CONTEST_TYPES.map((item) => [item.id, false]));
}

export function normalizeMusicCategories(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const categories = [];

  for (const item of value) {
    const category = sanitizeText(item);
    if (!category) {
      continue;
    }

    const key = category.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    categories.push(category);
  }

  return categories;
}

export function normalizeStatePayload(payload) {
  const state = payload && typeof payload === "object" ? payload : {};
  const legacyVotingClosed = Boolean(state.votingClosed);
  const votingClosedByContestType = buildDefaultVotingClosedState();
  const publicContestType = normalizeContestType(state.publicContestType);

  for (const contestType of CONTEST_TYPES) {
    const storedValue = state.votingClosedByContestType?.[contestType.id];
    votingClosedByContestType[contestType.id] = typeof storedValue === "boolean" ? storedValue : legacyVotingClosed;
  }

  return {
    resetVersion: Number.isFinite(Number(state.resetVersion)) ? Number(state.resetVersion) : 1,
    updatedAt: sanitizeText(state.updatedAt) || new Date().toISOString(),
    publicContestType,
    musicCategories: normalizeMusicCategories(state.musicCategories),
    votingClosedByContestType,
    votingClosed: votingClosedByContestType[DEFAULT_CONTEST_TYPE]
  };
}

export function deriveMusicCategoriesFromVideos(videos = []) {
  return normalizeMusicCategories(
    videos
      .filter((video) => normalizeContestType(video.contestType) === "bgm")
      .map((video) => video.musicCategory)
  );
}

export function stripLeadingNumber(title) {
  return String(title || "").replace(/^\d+\.\s*/, "");
}

export function jsonResponse(payload, init = 200) {
  const status = typeof init === "number" ? init : (init.status || 200);
  const headers = new Headers(typeof init === "number" ? undefined : init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers });
}

export function escapeFileName(value) {
  return encodeURIComponent(value).replace(/['()]/g, escape).replace(/\*/g, "%2A");
}
