export type SyncStatus = "loading" | "synced" | "saving" | "offline" | "error" | "local";

export const SYNC_META_KEY = "shine_body_sync_meta_v1";
export const CLOUD_STORAGE_NOT_CONFIGURED = "cloud storage not configured";
export const CLOUD_SAVE_DEBOUNCE_MS = 800;

export interface CloudDocument<T> {
  updatedAt: string;
  data: T;
  saved?: boolean;
}

export type CloudResult<T> =
  | { type: "empty" }
  | { type: "document"; document: CloudDocument<T> }
  | { type: "unconfigured" }
  | { type: "offline" }
  | { type: "unauthorized" }
  | { type: "error" };

export type SyncAction = "upload" | "download" | "keep";

export function readLocalUpdatedAt(): string | null {
  try {
    const raw = localStorage.getItem(SYNC_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { updatedAt?: unknown };
    if (typeof parsed.updatedAt !== "string" || Number.isNaN(Date.parse(parsed.updatedAt))) return null;
    return new Date(parsed.updatedAt).toISOString();
  } catch {
    return null;
  }
}

export function writeLocalUpdatedAt(updatedAt: string) {
  localStorage.setItem(SYNC_META_KEY, JSON.stringify({ updatedAt: new Date(updatedAt).toISOString() }));
}

export function decideSyncAction(input: {
  cloud: "empty" | "present";
  localUpdatedAt: string | null;
  cloudUpdatedAt: string | null;
  hasPersistedLocal: boolean;
  userEdited: boolean;
  localDate?: string;
  cloudDate?: string;
}): SyncAction {
  if (input.userEdited) return "upload";
  if (input.cloud === "empty") return input.hasPersistedLocal ? "upload" : "keep";
  if (!input.localUpdatedAt) return "download";

  const localTime = Date.parse(input.localUpdatedAt);
  const cloudTime = Date.parse(input.cloudUpdatedAt || "");
  if (Number.isNaN(cloudTime) || localTime > cloudTime) return "upload";
  if (cloudTime > localTime) return "download";
  if (input.localDate && input.cloudDate && input.localDate > input.cloudDate) return "upload";
  return "keep";
}

async function readResponseBody(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function interpretCloudResponse<T>(response: Response): Promise<CloudResult<T>> {
  const body = await readResponseBody(response);
  if (response.status === 503 && body?.error === CLOUD_STORAGE_NOT_CONFIGURED) {
    return { type: "unconfigured" };
  }
  if (response.status === 401) return { type: "unauthorized" };
  if (!response.ok || !body) return { type: "error" };
  if (body.updatedAt == null || body.data == null) return { type: "empty" };
  if (typeof body.updatedAt !== "string" || Number.isNaN(Date.parse(body.updatedAt))) return { type: "error" };
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return { type: "error" };
  return {
    type: "document",
    document: {
      updatedAt: new Date(body.updatedAt).toISOString(),
      data: body.data as T,
      saved: body.saved
    }
  };
}

export async function loadCloudDocument<T>(): Promise<CloudResult<T>> {
  try {
    const response = await fetch("/api/data", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin"
    });
    return interpretCloudResponse<T>(response);
  } catch {
    return { type: "offline" };
  }
}

export async function saveCloudDocument<T>(document: CloudDocument<T>): Promise<CloudResult<T>> {
  try {
    const response = await fetch("/api/data", {
      method: "PUT",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updatedAt: document.updatedAt, data: document.data })
    });
    return interpretCloudResponse<T>(response);
  } catch {
    return { type: "offline" };
  }
}

export const SYNC_STATUS_TEXT: Record<SyncStatus, { label: string; title: string }> = {
  loading: { label: "同步中", title: "正在讀取雲端資料" },
  synced: { label: "已同步", title: "雲端資料已是最新" },
  saving: { label: "儲存中", title: "正在把變更上傳到雲端" },
  offline: { label: "離線", title: "目前離線，變更會留在此瀏覽器，連線後再同步" },
  error: { label: "同步失敗", title: "雲端同步失敗，此瀏覽器的資料仍會保留" },
  local: { label: "僅本機", title: "尚未設定雲端儲存，資料只保存在此瀏覽器" }
};
