export const THEME_STORAGE_KEY = "codex-gateway-theme";
export const DEFAULT_THEME_ID = "ocean";

export const THEME_OPTIONS = [
  {
    id: "ocean",
    label: "Ocean",
    description: "Deep blue tech look",
    preview: ["#22c0c7", "#4d7cff", "#0a1728"],
  },
  {
    id: "slate",
    label: "Slate",
    description: "Calm slate neutral dark",
    preview: ["#60a5fa", "#94a3b8", "#111827"],
  },
  {
    id: "forest",
    label: "Forest",
    description: "Cool forest green",
    preview: ["#2ec27e", "#15b8a6", "#0d1f1a"],
  },
  {
    id: "sunset",
    label: "Sunset",
    description: "Warm sunset gradient",
    preview: ["#ff8a4c", "#f472b6", "#231214"],
  },
  {
    id: "grape",
    label: "Grape",
    description: "Purple night city tone",
    preview: ["#8b5cf6", "#38bdf8", "#1b1430"],
  },
  {
    id: "business",
    label: "Business",
    description: "Dark business gold",
    preview: ["#e7b64a", "#f4d38d", "#16120a"],
  },
];

const THEME_IDS = new Set(THEME_OPTIONS.map((option) => option.id));

export function normalizeThemeId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return THEME_IDS.has(normalized) ? normalized : DEFAULT_THEME_ID;
}

export function readStoredTheme() {
  try {
    return normalizeThemeId(window.localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME_ID);
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function persistTheme(themeId) {
  const normalized = normalizeThemeId(themeId);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, normalized);
  } catch {}
  return normalized;
}

export function applyTheme(themeId, options = {}) {
  const normalized = normalizeThemeId(themeId);
  document.documentElement.dataset.theme = normalized;
  if (options.persist === true) persistTheme(normalized);
  return normalized;
}

export function getThemeOptions() {
  return THEME_OPTIONS.slice();
}
