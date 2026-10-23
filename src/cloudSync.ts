export type SyncStatus = "loading" | "synced" | "saving" | "offline" | "error" | "local";

export const SYNC_META_KEY = "shine_body_sync_meta_v1";
export const CLOUD_STORAGE_NOT_CONFIGURED = "cloud storage not configured";
export const CLOUD_SAVE_DEBOUNCE_MS = 800;
export const CLOUD_REFRESH_INTERVAL_MS = 45_000;

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

export type SyncPlan = "apply-cloud" | "upload-local" | "merge" | "keep";

export function isNewerTimestamp(candidate: string | null, baseline: string | null) {
  if (!candidate) return false;
  const candidateTime = Date.parse(candidate);
  if (Number.isNaN(candidateTime)) return false;
  if (!baseline) return true;
  const baselineTime = Date.parse(baseline);
  if (Number.isNaN(baselineTime)) return true;
  return candidateTime > baselineTime;
}

export function mergeWeightHistory<T extends { date: string }>(
  localPoints: T[],
  cloudPoints: T[],
  prefer: "local" | "cloud"
) {
  const byDate = new Map<string, T>();
  const base = prefer === "cloud" ? localPoints : cloudPoints;
  const override = prefer === "cloud" ? cloudPoints : localPoints;
  for (const point of base) {
    if (point?.date) byDate.set(point.date, point);
  }
  for (const point of override) {
    if (point?.date) byDate.set(point.date, point);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function mergeRecordsById<T extends { id: string }>(localRecords: T[], cloudRecords: T[]) {
  const byId = new Map<string, T>();
  for (const record of cloudRecords) {
    if (record?.id) byId.set(record.id, record);
  }
  for (const record of localRecords) {
    if (record?.id && !byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

export function mergeCloudPayload<
  TCurrent extends { weightHistory?: Array<{ date: string }> },
  TRecord extends { id: string }
>(
  local: { current: TCurrent; records: TRecord[] },
  cloud: { current: TCurrent; records: TRecord[] }
): { current: TCurrent; records: TRecord[] } {
  const weightHistory = mergeWeightHistory(
    local.current.weightHistory || [],
    cloud.current.weightHistory || [],
    "cloud"
  );
  return {
    current: {
      ...cloud.current,
      ...local.current,
      weightHistory: weightHistory as TCurrent["weightHistory"]
    },
    records: mergeRecordsById(local.records || [], cloud.records || [])
  };
}

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

export function planSync(input: {
  cloud: "empty" | "present";
  localUpdatedAt: string | null;
  cloudUpdatedAt: string | null;
  hasPersistedLocal: boolean;
  dirty: boolean;
}): SyncPlan {
  if (input.cloud === "empty") {
    return input.hasPersistedLocal || input.dirty ? "upload-local" : "keep";
  }
  const cloudNewer = isNewerTimestamp(input.cloudUpdatedAt, input.localUpdatedAt);
  const localNewer = isNewerTimestamp(input.localUpdatedAt, input.cloudUpdatedAt);
  if (input.dirty && cloudNewer) return "merge";
  if (cloudNewer) return "apply-cloud";
  if (input.dirty || localNewer) return "upload-local";
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
      credentials: "same-origin",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" }
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
