import React, { useState, useEffect, useRef } from "react";

// LocalStorage and DB keys matching original safe version
const KEY = 'shine_body_standalone_v1';
const COOKIE_NAME = 'shine_body_current';
const COOKIE_FALLBACK_KEY = 'shine_body_cookie_fallback';
const DB_NAME = 'shine_body_history_v1';
const STORE = 'records';

const today = () => new Date().toLocaleDateString('en-CA');

interface Profile {
  gender: 'female' | 'male';
  age: number;
  height: number;
  weight: number;
  activity: number;
  goal: number;
  waterTarget: number;
  bmr: number;
  tdee: number;
  target: number;
}

interface FoodItem {
  id: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  meal: string;
  servings: number;
  portionAdjusted: boolean;
  totalCalories?: number;
}

interface ExerciseItem {
  id: string;
  name: string;
  duration: number;
  calories: number;
}

interface AppData {
  date: string;
  profile: Profile;
  water: number;
  foods: FoodItem[];
  exercises: ExerciseItem[];
  weightHistory: WeightHistoryPoint[];
}

interface SnapshotRecord {
  id: string;
  name: string;
  type: 'daily' | 'manual';
  createdAt: string;
  snapshot: AppData;
}

interface WeightHistoryPoint {
  date: string;
  label: string;
  weight: number;
}

// User-provided historical measurements. Keep the original values so the
// chart remains a faithful record even when the current profile is edited.
const INITIAL_WEIGHT_HISTORY: WeightHistoryPoint[] = [
  { date: '2025-08-03', label: '8/3', weight: 64.0 },
  { date: '2025-08-28', label: '8/28', weight: 62.6 },
  { date: '2025-08-31', label: '8/31', weight: 62.2 },
  { date: '2025-09-14', label: '9/14', weight: 62.4 },
  { date: '2025-10-10', label: '10/10', weight: 61.5 },
  { date: '2025-10-29', label: '10/29', weight: 60.9 },
  { date: '2025-12-15', label: '12/15', weight: 59.7 },
  { date: '2026-01-12', label: '1/12', weight: 60.8 },
  { date: '2026-02-04', label: '2/4', weight: 60.9 },
  { date: '2026-02-11', label: '2/11', weight: 61.9 },
  { date: '2026-02-16', label: '2/16', weight: 64.3 },
  { date: '2026-02-21', label: '2/21', weight: 65.1 },
  { date: '2026-03-19', label: '3/19', weight: 65.7 },
  { date: '2026-04-11', label: '4/11', weight: 66.4 },
  { date: '2026-04-14', label: '4/14', weight: 63.7 },
  { date: '2026-05-05', label: '5/5', weight: 64.6 },
  { date: '2026-05-11', label: '5/11', weight: 64.1 },
  { date: '2026-05-15', label: '5/15', weight: 63.5 },
  { date: '2026-05-29', label: '5/29', weight: 62.7 },
  { date: '2026-06-15', label: '6/15', weight: 64.7 },
  { date: '2026-06-23', label: '6/23', weight: 65.3 },
  { date: '2026-06-29', label: '6/29', weight: 63.8 },
  { date: '2026-07-09', label: '7/9', weight: 66.5 },
  { date: '2026-07-10', label: '7/10', weight: 66.8 },
  { date: '2026-07-12', label: '7/12', weight: 65.7 },
  { date: '2026-07-17', label: '7/17', weight: 64.2 }
];

const formatWeightLabel = (date: string) => {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : `${parsed.getMonth() + 1}/${parsed.getDate()}`;
};

const sortWeightHistory = (points: WeightHistoryPoint[]) => [...points].sort((a, b) => a.date.localeCompare(b.date));

const normalizeWeightHistory = (value: any): WeightHistoryPoint[] => {
  if (!Array.isArray(value)) return INITIAL_WEIGHT_HISTORY.map((point) => ({ ...point }));
  const normalized = value
    .filter((point: any) => point && typeof point.date === 'string' && Number.isFinite(Number(point.weight)))
    .map((point: any) => ({
      date: point.date,
      label: point.label || formatWeightLabel(point.date),
      weight: Math.round(Number(point.weight) * 10) / 10
    }));
  return normalized.length > 0 ? sortWeightHistory(normalized) : INITIAL_WEIGHT_HISTORY.map((point) => ({ ...point }));
};

const defaults: AppData = {
  date: today(),
  profile: {
    gender: 'female',
    age: 28,
    height: 160,
    weight: 55,
    activity: 1.375,
    goal: -400,
    waterTarget: 2000,
    bmr: 0,
    tdee: 0,
    target: 1400
  },
  water: 0,
  foods: [],
  exercises: [],
  weightHistory: INITIAL_WEIGHT_HISTORY.map((point) => ({ ...point }))
};

// METS configuration for exercises
const METS: Record<string, number> = {
  "快走": 4.3,
  "跑步": 8.3,
  "瑜伽": 2.5
};

export default function App() {
  // --- States ---
  const [data, setData] = useState<AppData>(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const merged = { ...defaults, ...parsed };
        merged.weightHistory = normalizeWeightHistory(parsed.weightHistory);
        // Check date change
        if (merged.date !== today()) {
          merged.date = today();
          merged.water = 0;
          merged.foods = [];
          merged.exercises = [];
          localStorage.setItem(KEY, JSON.stringify(merged));
        }
        return merged;
      }
    } catch (e) {
      console.error("Error loading localStorage data:", e);
    }
    return structuredClone(defaults);
  });

  // DB reference state
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [records, setRecords] = useState<SnapshotRecord[]>([]);
  const [recordSearch, setRecordSearch] = useState("");
  const [recordName, setRecordName] = useState("");
  const [cookieStatus, setCookieStatus] = useState("");
  
  // Profile settings inputs
  const [profileGender, setProfileGender] = useState<"female" | "male">(data.profile.gender);
  const [profileAge, setProfileAge] = useState<number>(data.profile.age);
  const [profileHeight, setProfileHeight] = useState<number>(data.profile.height);
  const [profileWeight, setProfileWeight] = useState<number>(data.profile.weight);
  const [profileActivity, setProfileActivity] = useState<number>(data.profile.activity);
  const [profileGoal, setProfileGoal] = useState<number>(data.profile.goal);
  const [profileWaterTarget, setProfileWaterTarget] = useState<number>(data.profile.waterTarget);

  // Irregular weight measurements for the trend chart
  const [weightDate, setWeightDate] = useState(today());
  const [weightValue, setWeightValue] = useState("");
  const [editingWeightDate, setEditingWeightDate] = useState<string | null>(null);

  // Water records
  const [waterAmount, setWaterAmount] = useState<number>(250);

  // New Food Form inputs
  const [foodName, setFoodName] = useState("");
  const [foodCalories, setFoodCalories] = useState<string>("");
  const [foodProtein, setFoodProtein] = useState<string>("0");
  const [foodCarbs, setFoodCarbs] = useState<string>("0");
  const [foodFat, setFoodFat] = useState<string>("0");
  const [foodMeal, setFoodMeal] = useState("早餐");

  // AI Food Photo Analysis
  const [shareCount, setShareCount] = useState<number>(1);
  const [selectedPhoto, setSelectedPhoto] = useState<{ dataUrl: string; base64: string; mimeType: string } | null>(null);
  const [aiStatus, setAiStatus] = useState("每位朋友的紀錄只保存在自己的瀏覽器；AI 結果僅為估算。");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [lastAiFood, setLastAiFood] = useState<any>(null);
  const [foodText, setFoodText] = useState("");
  const [foodFollowUpAnswer, setFoodFollowUpAnswer] = useState("");
  const [foodTextDraft, setFoodTextDraft] = useState<any>(null);
  const [textNeedsConfirmation, setTextNeedsConfirmation] = useState(false);
  const [isAnalyzingText, setIsAnalyzingText] = useState(false);
  const [aiSources, setAiSources] = useState<Array<{ title: string; url: string }>>([]);

  // Exercise Form inputs
  const [exerciseName, setExerciseName] = useState("快走");
  const [exerciseDuration, setExerciseDuration] = useState<string>("");
  const [exerciseCalories, setExerciseCalories] = useState<number>(0);

  // --- Refs ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  // --- DB Operations Helpers ---
  useEffect(() => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => {
      setDb(request.result);
    };
    request.onerror = (e) => {
      console.error("IndexedDB load error", e);
    };
  }, []);

  const putRecord = (dbInstance: IDBDatabase, record: SnapshotRecord): Promise<void> => {
    return new Promise((resolve, reject) => {
      const tx = dbInstance.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  const getRecords = (dbInstance: IDBDatabase): Promise<SnapshotRecord[]> => {
    return new Promise((resolve, reject) => {
      const request = dbInstance.transaction(STORE).objectStore(STORE).getAll();
      request.onsuccess = () => {
        const sorted = (request.result as SnapshotRecord[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        resolve(sorted);
      };
      request.onerror = () => reject(request.error);
    });
  };

  const deleteRecord = (dbInstance: IDBDatabase, id: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const tx = dbInstance.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  const clearRecords = (dbInstance: IDBDatabase): Promise<void> => {
    return new Promise((resolve, reject) => {
      const tx = dbInstance.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  // Sync records list
  const loadHistoryRecords = async (dbInstance: IDBDatabase) => {
    try {
      const loaded = await getRecords(dbInstance);
      setRecords(loaded);
    } catch (err) {
      console.error("Failed to load records", err);
    }
  };

  useEffect(() => {
    if (db) {
      loadHistoryRecords(db);
      // Auto archive today
      const currentSnapshot = structuredClone(data);
      putRecord(db, {
        id: `daily:${data.date}`,
        name: data.date,
        type: 'daily',
        createdAt: new Date().toISOString(),
        snapshot: currentSnapshot
      }).then(() => {
        loadHistoryRecords(db);
      }).catch(err => {
        console.error("Auto archive today failed", err);
      });
    }
  }, [db]);

  // --- Dynamic calculations ---
  const calculateProfile = (p: Profile): Profile => {
    let bmrVal = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.gender === 'male' ? 5 : -161);
    const bmr = Math.round(bmrVal);
    const tdee = Math.round(bmrVal * p.activity);
    const target = Math.max(1200, Math.round(tdee + p.goal));
    return { ...p, bmr, tdee, target };
  };

  const currentProfile = calculateProfile({
    gender: profileGender,
    age: profileAge,
    height: profileHeight,
    weight: profileWeight,
    activity: profileActivity,
    goal: profileGoal,
    waterTarget: profileWaterTarget,
    bmr: data.profile.bmr,
    tdee: data.profile.tdee,
    target: data.profile.target
  });

  // Calculate stats for today
  const eatenCalories = data.foods.reduce((sum, x) => sum + x.calories, 0);
  const burnedCalories = data.exercises.reduce((sum, x) => sum + x.calories, 0);
  const remainingCalories = currentProfile.target + burnedCalories - eatenCalories;

  // Auto calculate exercise calories based on selection and duration
  useEffect(() => {
    const met = METS[exerciseName] || 4.3;
    const minutes = Number(exerciseDuration) || 0;
    const weight = Number(profileWeight) || 0;
    const calculated = Math.max(0, Math.round(met * 3.5 * weight / 200 * minutes));
    setExerciseCalories(calculated);
  }, [exerciseName, exerciseDuration, profileWeight]);

  // Handle data updates & save
  const updateDataAndSave = (updated: AppData) => {
    setData(updated);
    localStorage.setItem(KEY, JSON.stringify(updated));
    if (db) {
      putRecord(db, {
        id: `daily:${updated.date}`,
        name: updated.date,
        type: 'daily',
        createdAt: new Date().toISOString(),
        snapshot: structuredClone(updated)
      }).then(() => {
        loadHistoryRecords(db);
      }).catch(e => {
        console.error("Auto archive failed inside save", e);
      });
    }
  };

  // --- Actions & Forms ---

  // Update profile
  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const updated = {
      ...data,
      profile: {
        gender: profileGender,
        age: profileAge,
        height: profileHeight,
        weight: profileWeight,
        activity: profileActivity,
        goal: profileGoal,
        waterTarget: profileWaterTarget,
        bmr: currentProfile.bmr,
        tdee: currentProfile.tdee,
        target: currentProfile.target
      }
    };
    updateDataAndSave(updated);
  };

  const resetWeightEditor = () => {
    setWeightDate(today());
    setWeightValue("");
    setEditingWeightDate(null);
  };

  const handleWeightSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedWeight = Number(weightValue);
    if (!weightDate || !Number.isFinite(parsedWeight) || parsedWeight < 25 || parsedWeight > 300) {
      alert("請輸入 25～300 kg 的有效體重與日期。");
      return;
    }

    const nextPoint: WeightHistoryPoint = {
      date: weightDate,
      label: formatWeightLabel(weightDate),
      weight: Math.round(parsedWeight * 10) / 10
    };
    const nextHistory = sortWeightHistory([
      ...(data.weightHistory || []).filter((point) => point.date !== editingWeightDate && point.date !== weightDate),
      nextPoint
    ]);
    updateDataAndSave({ ...data, weightHistory: nextHistory });
    resetWeightEditor();
  };

  const handleEditWeight = (point: WeightHistoryPoint) => {
    setEditingWeightDate(point.date);
    setWeightDate(point.date);
    setWeightValue(String(point.weight));
  };

  const handleDeleteWeight = (date: string) => {
    if ((data.weightHistory || []).length <= 1) {
      alert("至少保留一筆體重紀錄，才能繪製趨勢圖。");
      return;
    }
    if (!window.confirm(`確定刪除 ${date} 的體重紀錄？`)) return;
    updateDataAndSave({
      ...data,
      weightHistory: (data.weightHistory || []).filter((point) => point.date !== date)
    });
    if (editingWeightDate === date) resetWeightEditor();
  };

  // Add water
  const handleAddWater = () => {
    const updated = { ...data, water: data.water + waterAmount };
    updateDataAndSave(updated);
  };

  const handleResetWater = () => {
    const updated = { ...data, water: 0 };
    updateDataAndSave(updated);
  };

  // AI Photo handling
  const compressPhoto = (file: File): Promise<{ dataUrl: string; base64: string; mimeType: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const image = new Image();
        image.onload = () => {
          let width = image.width;
          let height = image.height;
          const max = 1024;
          if (width > max || height > max) {
            const ratio = Math.min(max / width, max / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(image, 0, 0, width, height);
            // Qwen's inline image endpoint has a roughly 180 KB limit. Keep
            // the browser payload below that limit so Qwen can remain the
            // primary model instead of falling back for ordinary phone photos.
            let quality = 0.78;
            let dataUrl = canvas.toDataURL('image/jpeg', quality);
            const inlineLimitBytes = 170_000;
            const base64Bytes = (value: string) => {
              const comma = value.indexOf(',');
              return comma >= 0 ? Math.ceil((value.length - comma - 1) * 3 / 4) : 0;
            };
            while (base64Bytes(dataUrl) > inlineLimitBytes && quality > 0.38) {
              quality = Math.max(0.38, quality - 0.08);
              dataUrl = canvas.toDataURL('image/jpeg', quality);
            }
            resolve({
              dataUrl,
              base64: dataUrl.split(',')[1],
              mimeType: 'image/jpeg'
            });
          } else {
            reject(new Error("Canvas context is null"));
          }
        };
        image.onerror = reject;
        image.src = reader.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAiStatus("正在準備照片…");
    try {
      const compressed = await compressPhoto(file);
      setSelectedPhoto(compressed);
      setLastAiFood(null);
      setAiStatus("照片已準備好，請點「AI 分析照片」。");
    } catch (err) {
      setAiStatus("無法讀取這張照片，請更換檔案。");
    }
  };

  // Portion Recalculation
  const recalculateAiPortion = (aiFood: any, people: number, statusMessage?: string) => {
    if (!aiFood) return;
    const divide = (value: any) => Math.round((Math.max(0, Number(value) || 0) / people) * 10) / 10;
    
    setFoodName(aiFood.foodName || aiFood.name || '');
    setFoodCalories(String(Math.round(divide(aiFood.calories))));
    setFoodProtein(String(divide(aiFood.protein)));
    setFoodCarbs(String(divide(aiFood.carbs)));
    setFoodFat(String(divide(aiFood.fat)));
    
    setAiStatus(statusMessage || `Gemini AI 分析完成：整份共 ${Math.round(Number(aiFood.calories) || 0)} kcal${people > 1 ? `，除以 ${people} 人後每人約 ${Math.round(divide(aiFood.calories))} kcal` : '，目前未分食'}。${aiFood.description || '請確認數字後再新增。'}`);
  };

  useEffect(() => {
    if (lastAiFood) {
      recalculateAiPortion(lastAiFood, shareCount);
    }
  }, [shareCount]);

  const handleAnalyzePhoto = async () => {
    if (!selectedPhoto) {
      alert("請先選擇食物照片");
      return;
    }
    
    setIsAnalyzing(true);
    setAiStatus("NVIDIA Vision 正在透過安全伺服器分析（失敗時才回退 Gemini）…");

    try {
      const response = await fetch("/api/analyze-food", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: selectedPhoto.base64,
          mimeType: selectedPhoto.mimeType,
        })
      });

      let result: any = null;
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        result = await response.json();
      } else {
        const text = await response.text();
        throw new Error(text.slice(0, 150) || `HTTP 伺服器回傳非 JSON 格式 (${response.status})`);
      }

      if (!response.ok) {
        throw new Error(result?.error || `HTTP ${response.status}`);
      }

      setLastAiFood(result.food);
      recalculateAiPortion(
        result.food,
        shareCount,
        `${result.provider || "AI"} 分析完成：整份共 ${Math.round(Number(result.food?.calories) || 0)} kcal${shareCount > 1 ? `，除以 ${shareCount} 人後每人約 ${Math.round((Number(result.food?.calories) || 0) / shareCount)} kcal` : "，目前未分食"}。${result.notes || result.food?.description || "請確認數字後再新增。"}`
      );

    } catch (error: any) {
      console.error(error);
      setAiStatus(`分析失敗：${error.message || error}。可稍後再試或手動輸入。`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleAnalyzeFoodText = async () => {
    const query = foodText.trim();
    if (!query) {
      alert("請先輸入餐點名稱或描述");
      return;
    }
    if (textNeedsConfirmation && !foodFollowUpAnswer.trim()) {
      alert("請先回答上方的補充問題");
      return;
    }

    setIsAnalyzingText(true);
    setAiStatus("Gemini 正在搜尋餐點資料與營養標示…");
    try {
      const response = await fetch("/api/analyze-food-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: query,
          followUpAnswer: foodFollowUpAnswer.trim() || undefined,
          previous: foodTextDraft || undefined
        })
      });
      const contentType = response.headers.get("content-type") || "";
      const result: any = contentType.includes("application/json")
        ? await response.json()
        : { error: (await response.text()).slice(0, 180) };
      if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);

      setAiSources(Array.isArray(result.sources) ? result.sources : []);
      if (result.status === "needs_confirmation") {
        setFoodTextDraft(result.food || null);
        setTextNeedsConfirmation(true);
        setAiStatus(`需要確認：${result.question || "請補充餐點份量或內容。"}${result.food?.calories ? `（目前暫估 ${Math.round(Number(result.food.calories))} kcal）` : ""}`);
        return;
      }

      setLastAiFood(result.food);
      setFoodTextDraft(null);
      setTextNeedsConfirmation(false);
      setFoodFollowUpAnswer("");
      recalculateAiPortion(
        result.food,
        shareCount,
        `自然語言查詢完成（${result.provider || "AI"}）：整份約 ${Math.round(Number(result.food?.calories) || 0)} kcal。${result.notes || result.food?.description || "請確認數字後再新增。"}`
      );
    } catch (error: any) {
      console.error(error);
      setAiStatus(`查詢失敗：${error.message || error}。可手動輸入熱量。`);
    } finally {
      setIsAnalyzingText(false);
    }
  };

  // Add food submit
  const handleFoodSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (textNeedsConfirmation) {
      alert("請先回答自然語言分析的補充問題，再新增飲食。");
      return;
    }
    const servings = shareCount || 1;
    const newFood: FoodItem = {
      id: crypto.randomUUID(),
      name: foodName.trim() || "無名餐點",
      calories: Number(foodCalories) || 0,
      protein: Number(foodProtein) || 0,
      carbs: Number(foodCarbs) || 0,
      fat: Number(foodFat) || 0,
      meal: foodMeal,
      servings,
      portionAdjusted: lastAiFood ? true : servings === 1,
      totalCalories: lastAiFood ? Math.round(Number(lastAiFood.calories) || 0) : undefined
    };

    const updated = {
      ...data,
      foods: [newFood, ...data.foods]
    };

    updateDataAndSave(updated);

    // Reset Form
    setFoodName("");
    setFoodCalories("");
    setFoodProtein("0");
    setFoodCarbs("0");
    setFoodFat("0");
    setShareCount(1);
    setSelectedPhoto(null);
    setLastAiFood(null);
    setFoodText("");
    setFoodFollowUpAnswer("");
    setFoodTextDraft(null);
    setTextNeedsConfirmation(false);
    setAiSources([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setAiStatus("飲食紀錄已新增，可繼續選擇下一張照片。");
  };

  // Deletion and interactive division
  const handleDeleteFood = (id: string) => {
    const updated = {
      ...data,
      foods: data.foods.filter(x => x.id !== id)
    };
    updateDataAndSave(updated);
  };

  const handleApplyPortionSharing = (id: string) => {
    const item = data.foods.find(x => x.id === id);
    if (item && item.servings > 1) {
      if (window.confirm(`將這筆 ${item.calories} kcal 除以 ${item.servings} 人份，修正為每人熱量？`)) {
        const divide = (value: number) => Math.round((Math.max(0, value) / item.servings) * 10) / 10;
        const updatedFoods = data.foods.map(x => {
          if (x.id === id) {
            return {
              ...x,
              totalCalories: x.calories,
              calories: Math.round(divide(x.calories)),
              protein: divide(x.protein),
              carbs: divide(x.carbs),
              fat: divide(x.fat),
              portionAdjusted: true
            };
          }
          return x;
        });

        const updated = {
          ...data,
          foods: updatedFoods
        };
        updateDataAndSave(updated);
      }
    }
  };

  // Add Exercise Form
  const handleExerciseSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newEx: ExerciseItem = {
      id: crypto.randomUUID(),
      name: exerciseName,
      duration: Number(exerciseDuration) || 0,
      calories: exerciseCalories
    };

    const updated = {
      ...data,
      exercises: [newEx, ...data.exercises]
    };

    updateDataAndSave(updated);
    setExerciseDuration("");
  };

  const handleDeleteExercise = (id: string) => {
    const updated = {
      ...data,
      exercises: data.exercises.filter(x => x.id !== id)
    };
    updateDataAndSave(updated);
  };

  // Save manual snapshot
  const handleSaveSnapshot = async () => {
    if (!db) {
      alert("資料庫尚未就緒。");
      return;
    }
    const name = recordName.trim();
    if (!name) {
      alert("請先輸入快照名稱");
      return;
    }
    await putRecord(db, {
      id: `manual:${crypto.randomUUID()}`,
      name,
      type: 'manual',
      createdAt: new Date().toISOString(),
      snapshot: structuredClone(data)
    });
    setRecordName("");
    loadHistoryRecords(db);
  };

  const handleDeleteRecord = async (id: string) => {
    if (!db) return;
    if (window.confirm("確定刪除這組歷史紀錄？")) {
      await deleteRecord(db, id);
      loadHistoryRecords(db);
    }
  };

  const handleLoadRecord = async (id: string) => {
    if (!db) return;
    const record = records.find(r => r.id === id);
    if (record) {
      if (window.confirm(`載入「${record.name}」為目前資料？目前尚未另存的內容會被取代。`)) {
        const restored = structuredClone(record.snapshot);
        restored.date = today();
        restored.weightHistory = normalizeWeightHistory(restored.weightHistory);
        setData(restored);
        
        // Sync states of profile inputs
        setProfileGender(restored.profile.gender);
        setProfileAge(restored.profile.age);
        setProfileHeight(restored.profile.height);
        setProfileWeight(restored.profile.weight);
        setProfileActivity(restored.profile.activity);
        setProfileGoal(restored.profile.goal);
        setProfileWaterTarget(restored.profile.waterTarget);

        localStorage.setItem(KEY, JSON.stringify(restored));
        loadHistoryRecords(db);
      }
    }
  };

  // --- Cookie operations ---
  const readCookie = (name: string): string => {
    const prefix = `${name}=`;
    return document.cookie.split('; ').find(x => x.startsWith(prefix))?.slice(prefix.length) || '';
  };

  const saveCurrentToCookie = () => {
    const encoded = encodeURIComponent(JSON.stringify(data));
    let usedCookie = false;
    if (encoded.length <= 3500) {
      document.cookie = `${COOKIE_NAME}=${encoded}; Max-Age=31536000; Path=/; SameSite=Lax`;
      usedCookie = readCookie(COOKIE_NAME) === encoded;
    }
    if (usedCookie) {
      localStorage.removeItem(COOKIE_FALLBACK_KEY);
      setCookieStatus('目前資料已儲存到 Cookie，有效期一年。');
    } else {
      localStorage.setItem(COOKIE_FALLBACK_KEY, encoded);
      setCookieStatus(encoded.length > 3500 ? '資料超過 Cookie 容量，已改用本機替代儲存。' : '本機檔案模式不支援 Cookie，已改用本機替代儲存。');
    }
  };

  const loadCurrentFromCookie = () => {
    try {
      const encoded = readCookie(COOKIE_NAME) || localStorage.getItem(COOKIE_FALLBACK_KEY);
      if (!encoded) {
        setCookieStatus('目前沒有 Cookie 或替代儲存資料。');
        return;
      }
      const restored = JSON.parse(decodeURIComponent(encoded));
      if (!restored.profile || !Array.isArray(restored.foods) || !Array.isArray(restored.exercises)) {
        throw new Error("Invalid format");
      }
      restored.weightHistory = normalizeWeightHistory(restored.weightHistory);
      setData(restored);

      // Sync form fields
      setProfileGender(restored.profile.gender);
      setProfileAge(restored.profile.age);
      setProfileHeight(restored.profile.height);
      setProfileWeight(restored.profile.weight);
      setProfileActivity(restored.profile.activity);
      setProfileGoal(restored.profile.goal);
      setProfileWaterTarget(restored.profile.waterTarget);

      localStorage.setItem(KEY, JSON.stringify(restored));
      setCookieStatus('已載入 Cookie／本機替代資料。');
    } catch {
      setCookieStatus('Cookie 資料格式不正確，無法載入。');
    }
  };

  const removeCurrentCookie = () => {
    document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
    localStorage.removeItem(COOKIE_FALLBACK_KEY);
    setCookieStatus('Cookie 與本機替代資料已清除。');
  };

  // --- Data backups & clear ---
  const handleExportData = async () => {
    let historyRecords: SnapshotRecord[] = [];
    if (db) {
      historyRecords = await getRecords(db);
    }
    const backup = {
      format: 'shine-body-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      current: data,
      records: historyRecords
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    a.download = `閃耀體態完整備份-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const d = raw.current || raw;
      if (!d.profile || !Array.isArray(d.foods) || !Array.isArray(d.exercises)) {
        throw new Error("格式錯誤");
      }
      d.weightHistory = normalizeWeightHistory(d.weightHistory);
      if (Array.isArray(raw.records) && db) {
        for (const record of raw.records) {
          await putRecord(db, record);
        }
      }
      setData(d);

      setProfileGender(d.profile.gender);
      setProfileAge(d.profile.age);
      setProfileHeight(d.profile.height);
      setProfileWeight(d.profile.weight);
      setProfileActivity(d.profile.activity);
      setProfileGoal(d.profile.goal);
      setProfileWaterTarget(d.profile.waterTarget);

      localStorage.setItem(KEY, JSON.stringify(d));
      if (db) {
        await loadHistoryRecords(db);
      }
      alert(`匯入完成${raw.records ? `，包含 ${raw.records.length} 組歷史紀錄` : ''}`);
    } catch {
      alert('備份檔格式不正確');
    } finally {
      if (importFileInputRef.current) {
        importFileInputRef.current.value = "";
      }
    }
  };

  const handleClearAllData = async () => {
    if (window.confirm('確定清除目前資料及全部歷史紀錄？此動作無法復原。API Key 會保留。')) {
      if (db) {
        await clearRecords(db);
      }
      const reset = structuredClone(defaults);
      setData(reset);
      setProfileGender(reset.profile.gender);
      setProfileAge(reset.profile.age);
      setProfileHeight(reset.profile.height);
      setProfileWeight(reset.profile.weight);
      setProfileActivity(reset.profile.activity);
      setProfileGoal(reset.profile.goal);
      setProfileWaterTarget(reset.profile.waterTarget);

      localStorage.removeItem(KEY);
      localStorage.setItem(KEY, JSON.stringify(reset));
      if (db) {
        await loadHistoryRecords(db);
      }
    }
  };

  // Filter local history records
  const filteredRecords = records.filter(r => {
    const term = recordSearch.trim().toLowerCase();
    if (!term) return true;
    return `${r.name} ${r.snapshot?.date || ''}`.toLowerCase().includes(term);
  });

  const weightHistory = sortWeightHistory(normalizeWeightHistory(data.weightHistory));
  const weightValues = weightHistory.map((point) => point.weight);
  const weightChart = {
    width: 1420,
    height: 540,
    left: 88,
    right: 30,
    top: 54,
    bottom: 126,
    min: Math.min(59, Math.floor(Math.min(...weightValues))),
    max: Math.max(68, Math.ceil(Math.max(...weightValues)))
  };
  const weightPlotWidth = weightChart.width - weightChart.left - weightChart.right;
  const weightPlotHeight = weightChart.height - weightChart.top - weightChart.bottom;
  const weightPoints = weightHistory.map((point, index) => ({
    ...point,
    x: weightChart.left + (index / Math.max(1, weightHistory.length - 1)) * weightPlotWidth,
    y: weightChart.top + ((weightChart.max - point.weight) / (weightChart.max - weightChart.min)) * weightPlotHeight
  }));
  const weightLine = weightPoints.map((point) => `${point.x},${point.y}`).join(' ');
  const weightArea = `M ${weightPoints[0].x} ${weightChart.height - weightChart.bottom} L ${weightLine.replaceAll(',', ' ')} L ${weightPoints[weightPoints.length - 1].x} ${weightChart.height - weightChart.bottom} Z`;
  const weightTicks = Array.from(
    { length: weightChart.max - weightChart.min + 1 },
    (_, index) => weightChart.min + index
  );
  const lowestWeight = Math.min(...weightHistory.map((point) => point.weight));
  const latestWeight = weightHistory[weightHistory.length - 1].weight;
  const weightChange = Math.round((latestWeight - weightHistory[0].weight) * 10) / 10;

  return (
    <>
      <header>
        <div className="brand-heading">
          <img className="bear-brand-icon" src="/assets/sansan-bear-icon.svg" alt="珊珊熊熊" />
          <div>
            <h1>✨ 閃耀體態</h1>
            <p>飲食卡路里管家・AI 智能升級版</p>
          </div>
        </div>
        <div className="tag">健康紀錄只存在此瀏覽器；照片經安全伺服器傳給 Gemini AI 分析</div>
      </header>

      <main>
        {/* Stats card */}
        <section className="card wide">
          <div className="stats">
            <div className="stat">
              <small>今日攝取</small>
              <b id="eaten">{eatenCalories}</b>
              <small>kcal</small>
            </div>
            <div className="stat">
              <small>運動消耗</small>
              <b id="burned">{burnedCalories}</b>
              <small>kcal</small>
            </div>
            <div className="stat">
              <small>剩餘額度</small>
              <b id="remaining">{remainingCalories}</b>
              <small>kcal</small>
            </div>
            <div className="stat">
              <small>喝水進度</small>
              <b id="waterStat">{data.water}</b>
              <small>ml</small>
            </div>
          </div>
          <div className="progress">
            <i
              id="waterBar"
              style={{
                width: `${Math.min(100, (data.water / (currentProfile.waterTarget || 2000)) * 100)}%`
              }}
            ></i>
          </div>
        </section>

        <div className="grid">
          {/* Profile settings card */}
          <section className="card">
            <h2>⚙️ 個人體態設定</h2>
            <form id="profileForm" onSubmit={handleProfileSubmit}>
              <div className="fields">
                <label>
                  生理性別
                  <select
                    id="gender"
                    value={profileGender}
                    onChange={(e) => setProfileGender(e.target.value as "female" | "male")}
                  >
                    <option value="female">女性</option>
                    <option value="male">男性</option>
                  </select>
                </label>
                <label>
                  年齡
                  <input
                    id="age"
                    type="number"
                    min="12"
                    max="100"
                    required
                    value={profileAge}
                    onChange={(e) => setProfileAge(Number(e.target.value))}
                  />
                </label>
                <label>
                  身高 cm
                  <input
                    id="height"
                    type="number"
                    min="100"
                    max="250"
                    required
                    value={profileHeight}
                    onChange={(e) => setProfileHeight(Number(e.target.value))}
                  />
                </label>
                <label>
                  體重 kg
                  <input
                    id="weight"
                    type="number"
                    min="25"
                    max="300"
                    step="0.1"
                    required
                    value={profileWeight}
                    onChange={(e) => setProfileWeight(Number(e.target.value))}
                  />
                </label>
                <label>
                  活動程度
                  <select
                    id="activity"
                    value={profileActivity}
                    onChange={(e) => setProfileActivity(Number(e.target.value))}
                  >
                    <option value="1.2">久坐</option>
                    <option value="1.375">輕度活動</option>
                    <option value="1.55">中度活動</option>
                    <option value="1.725">高度活動</option>
                  </select>
                </label>
                <label>
                  目標
                  <select
                    id="goal"
                    value={profileGoal}
                    onChange={(e) => setProfileGoal(Number(e.target.value))}
                  >
                    <option value="-400">減脂</option>
                    <option value="0">維持</option>
                    <option value="300">增肌</option>
                  </select>
                </label>
                <label>
                  每日喝水目標 ml
                  <input
                    id="waterTarget"
                    type="number"
                    min="500"
                    max="6000"
                    step="100"
                    value={profileWaterTarget}
                    onChange={(e) => setProfileWaterTarget(Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="actions">
                <button type="submit">儲存並計算</button>
              </div>
            </form>
            <div id="bodyResult" className="notice">
              BMR {currentProfile.bmr} kcal・TDEE {currentProfile.tdee} kcal・每日目標 {currentProfile.target} kcal
            </div>
          </section>

          {/* Embedded historical weight chart */}
          <section className="card wide weight-card">
            <div className="weight-heading">
              <div>
                <h2>❄️ 珊珊體重趨勢</h2>
                <p>已嵌入你提供的 2025–2026 測量紀錄</p>
              </div>
              <div className="weight-summary">
                <span><b>{latestWeight.toFixed(1)}</b> kg<br /><small>最新</small></span>
                <span><b>{lowestWeight.toFixed(1)}</b> kg<br /><small>最低點</small></span>
                <span><b>{weightChange > 0 ? '+' : ''}{weightChange.toFixed(1)}</b> kg<br /><small>相比第一筆</small></span>
              </div>
            </div>
            <div className="weight-chart-shell">
              <svg
                className="weight-chart"
                viewBox={`0 0 ${weightChart.width} ${weightChart.height}`}
                role="img"
                aria-label="2025 到 2026 年歷史體重折線圖"
              >
                <defs>
                  <linearGradient id="weightSky" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#b8e4f7" />
                    <stop offset="100%" stopColor="#eaf8ff" />
                  </linearGradient>
                  <linearGradient id="weightArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.78" />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0.08" />
                  </linearGradient>
                  <filter id="weightShadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#5b9fc0" floodOpacity="0.35" />
                  </filter>
                </defs>
                <rect width={weightChart.width} height={weightChart.height} rx="24" fill="url(#weightSky)" />
                <text x="42" y="42" className="weight-snowflake">✦</text>
                <text x={weightChart.width - 68} y="52" className="weight-snowflake">✧</text>
                <text x={weightChart.width / 2} y="37" textAnchor="middle" className="weight-chart-title">珊珊體重趨勢</text>

                {weightTicks.map((tick) => {
                  const y = weightChart.top + ((weightChart.max - tick) / (weightChart.max - weightChart.min)) * weightPlotHeight;
                  return (
                    <g key={tick}>
                      <line
                        x1={weightChart.left}
                        x2={weightChart.width - weightChart.right}
                        y1={y}
                        y2={y}
                        className="weight-gridline"
                      />
                      <text x={weightChart.left - 16} y={y + 5} textAnchor="end" className="weight-axis-label">{tick}</text>
                    </g>
                  );
                })}

                <text x="28" y={weightChart.top + weightPlotHeight / 2} textAnchor="middle" className="weight-axis-title" transform={`rotate(-90 28 ${weightChart.top + weightPlotHeight / 2})`}>體重（kg）</text>
                <line x1={weightChart.left} x2={weightChart.left} y1={weightChart.top} y2={weightChart.height - weightChart.bottom} className="weight-axis" />
                <line x1={weightChart.left} x2={weightChart.width - weightChart.right} y1={weightChart.height - weightChart.bottom} y2={weightChart.height - weightChart.bottom} className="weight-axis" />

                <path d={weightArea} fill="url(#weightArea)" />
                <polyline points={weightLine} fill="none" stroke="#ffffff" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
                <polyline points={weightLine} fill="none" stroke="#74b9d8" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />

                {weightPoints.map((point, index) => (
                  <g key={point.date} filter="url(#weightShadow)">
                    <image href="/assets/sansan-bear-icon.svg" x={point.x - 18} y={point.y - 18} width="36" height="36" preserveAspectRatio="xMidYMid slice" aria-label={`${point.date} ${point.weight} kg`} />
                    <text x={point.x} y={point.y - 23} textAnchor="middle" className="weight-value-label">{point.weight.toFixed(1)}</text>
                    <text x={point.x} y={weightChart.height - weightChart.bottom + 30} textAnchor="middle" className="weight-date-label" transform={`rotate(-42 ${point.x} ${weightChart.height - weightChart.bottom + 30})`}>{point.label}</text>
                    {index === 0 || weightHistory[index - 1].date.slice(0, 4) !== point.date.slice(0, 4) ? (
                      <text x={point.x} y={weightChart.height - 18} textAnchor="middle" className="weight-year-label">{point.date.slice(0, 4)}</text>
                    ) : null}
                  </g>
                ))}
                <text x={weightChart.width / 2} y={weightChart.height - 18} textAnchor="middle" className="weight-axis-title">日期</text>
              </svg>
            </div>
            <form id="weightForm" className="weight-entry" onSubmit={handleWeightSubmit}>
              <div className="weight-entry-heading">
                <img className="bear-ai-icon" src="/assets/sansan-bear-icon.svg" alt="珊珊熊熊" />
                <div>
                  <b>{editingWeightDate ? "修改體重紀錄" : "不定時新增體重"}</b>
                  <div className="notice">不用每天輸入；有測量時填寫日期與體重，儲存後會立即更新趨勢圖。</div>
                </div>
              </div>
              <div className="fields">
                <label>
                  日期
                  <input id="weightDate" type="date" required value={weightDate} onChange={(e) => setWeightDate(e.target.value)} />
                </label>
                <label>
                  體重 kg
                  <input id="weightValue" type="number" min="25" max="300" step="0.1" required value={weightValue} onChange={(e) => setWeightValue(e.target.value)} placeholder="例如：64.2" />
                </label>
              </div>
              <div className="actions">
                <button className="pink" type="submit">{editingWeightDate ? "更新體重" : "新增體重"}</button>
                {editingWeightDate && <button className="ghost" type="button" onClick={resetWeightEditor}>取消修改</button>}
              </div>
            </form>
            <details className="weight-records">
              <summary>管理體重紀錄（{weightHistory.length} 筆）</summary>
              <div className="weight-record-list">
                {[...weightHistory].reverse().map((point) => (
                  <div className="weight-record" key={point.date}>
                    <span><b>{point.date}</b>・{point.weight.toFixed(1)} kg</span>
                    <span className="actions">
                      <button className="ghost" type="button" onClick={() => handleEditWeight(point)}>編輯</button>
                      <button className="danger" type="button" onClick={() => handleDeleteWeight(point.date)}>刪除</button>
                    </span>
                  </div>
                ))}
              </div>
            </details>
            <div className="notice weight-note">最低點為 2025/12/15 的 {lowestWeight.toFixed(1)} kg；圖表資料是你提供的歷史測量，不會因修改目前體重設定而被覆蓋。</div>
          </section>

          {/* Water card */}
          <section className="card">
            <h2>💧 今日喝水</h2>
            <div className="fields">
              <label>
                增加水量 ml
                <input
                  id="waterAmount"
                  type="number"
                  min="50"
                  step="50"
                  value={waterAmount}
                  onChange={(e) => setWaterAmount(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="actions">
              <button id="addWater" onClick={handleAddWater}>＋ 記錄喝水</button>
              <button id="resetWater" className="ghost" onClick={handleResetWater}>歸零</button>
            </div>
            <div className="notice">每次喝水後按一下記錄；每天首次開啟會自動重設。</div>
          </section>

          {/* Add Food Card */}
          <section className="card">
            <h2>🍱 新增飲食</h2>
            <div className="ai-box" style={{ marginBottom: "12px" }}>
              <div className="ai-heading"><img className="bear-ai-icon" src="/assets/sansan-bear-icon.svg" alt="珊珊熊熊" /><b>💬 自然語言查詢熱量</b></div>
              <div className="notice" style={{ marginTop: "6px" }}>
                直接輸入「711 阜杭豆漿飯糰」或「雞胸肉便當」；目前優先使用 NVIDIA API 估算，資訊不足時再向你確認。
              </div>
              <label style={{ display: "block", marginTop: "9px" }}>
                餐點描述
                <textarea
                  id="foodText"
                  rows={2}
                  value={foodText}
                  onChange={(e) => setFoodText(e.target.value)}
                  placeholder="例如：711 阜杭豆漿飯糰、雞胸肉便當（飯吃一半）"
                  disabled={isAnalyzingText}
                />
              </label>
              {textNeedsConfirmation && (
                <label style={{ display: "block", marginTop: "9px" }}>
                  補充回答
                  <input
                    id="foodFollowUpAnswer"
                    value={foodFollowUpAnswer}
                    onChange={(e) => setFoodFollowUpAnswer(e.target.value)}
                    placeholder="請回答上方問題，例如：白飯正常一碗，沒有炸物"
                    disabled={isAnalyzingText}
                  />
                </label>
              )}
              <div className="actions">
                <button
                  id="analyzeFoodText"
                  className="pink"
                  type="button"
                  disabled={isAnalyzingText || !foodText.trim() || (textNeedsConfirmation && !foodFollowUpAnswer.trim())}
                  onClick={handleAnalyzeFoodText}
                >
                  {isAnalyzingText ? "搜尋中…" : textNeedsConfirmation ? "送出補充回答" : "查詢熱量"}
                </button>
              </div>
            </div>
            <div className="ai-box">
              <div className="ai-heading"><img className="bear-ai-icon" src="/assets/sansan-bear-icon.svg" alt="珊珊熊熊" /><b>✨ AI 影像辨識</b></div>
              <div className="fields" style={{ marginTop: "9px" }}>
                <div className="notice">照片分析服務：NVIDIA Vision（主要），Gemini（備援）。API key 只在伺服器端維護。</div>
                <label>
                  選擇或拍攝食物照片
                  <input
                    id="foodPhoto"
                    type="file"
                    accept="image/*"
                    ref={fileInputRef}
                    onChange={handlePhotoChange}
                  />
                </label>
                <label>
                  合菜分食人數
                  <select
                    id="shareCount"
                    value={shareCount}
                    onChange={(e) => setShareCount(Number(e.target.value))}
                  >
                    <option value="1">1 人份（不除）</option>
                    <option value="2">2 人份</option>
                    <option value="3">3 人份</option>
                    <option value="4">4 人份</option>
                    <option value="5">5 人份</option>
                    <option value="6">6 人份</option>
                    <option value="7">7 人份</option>
                    <option value="8">8 人份</option>
                    <option value="9">9 人份</option>
                    <option value="10">10 人份</option>
                    <option value="12">12 人份</option>
                  </select>
                </label>
              </div>
              <div className="actions">
                <button
                  id="analyzePhoto"
                  className="pink"
                  type="button"
                  disabled={!selectedPhoto || isAnalyzing}
                  onClick={handleAnalyzePhoto}
                >
                  {isAnalyzing ? "分析中..." : "AI 分析照片"}
                </button>
              </div>
              {selectedPhoto && (
                <img
                  id="photoPreview"
                  src={selectedPhoto.dataUrl}
                  alt="食物照片預覽"
                  style={{ display: "block" }}
                />
              )}
              <div id="aiStatus" className="status">{aiStatus}</div>
              {aiSources.length > 0 && (
                <div className="notice" style={{ marginTop: "8px" }}>
                  資料來源：{aiSources.map((source, index) => (
                    <React.Fragment key={source.url}>
                      {index > 0 ? "、" : ""}
                      <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>

            <form id="foodForm" onSubmit={handleFoodSubmit}>
              <div className="fields">
                <label>
                  餐點名稱
                  <input
                    id="foodName"
                    required
                    placeholder="例如：雞胸便當"
                    value={foodName}
                    onChange={(e) => setFoodName(e.target.value)}
                  />
                </label>
                <label>
                  熱量 kcal
                  <input
                    id="foodCalories"
                    type="number"
                    min="0"
                    required
                    value={foodCalories}
                    onChange={(e) => setFoodCalories(e.target.value)}
                  />
                </label>
                <label>
                  蛋白質 g
                  <input
                    id="protein"
                    type="number"
                    min="0"
                    step="0.1"
                    value={foodProtein}
                    onChange={(e) => setFoodProtein(e.target.value)}
                  />
                </label>
                <label>
                  碳水 g
                  <input
                    id="carbs"
                    type="number"
                    min="0"
                    step="0.1"
                    value={foodCarbs}
                    onChange={(e) => setFoodCarbs(e.target.value)}
                  />
                </label>
                <label>
                  脂肪 g
                  <input
                    id="fat"
                    type="number"
                    min="0"
                    step="0.1"
                    value={foodFat}
                    onChange={(e) => setFoodFat(e.target.value)}
                  />
                </label>
                <label>
                  餐別
                  <select
                    id="meal"
                    value={foodMeal}
                    onChange={(e) => setFoodMeal(e.target.value)}
                  >
                    <option>早餐</option>
                    <option>午餐</option>
                    <option>晚餐</option>
                    <option>點心</option>
                  </select>
                </label>
              </div>
              <div className="actions">
                <button className="pink" type="submit">新增飲食</button>
              </div>
            </form>

            {/* Food item listing */}
            <div id="foodList" className="list">
              {data.foods.length > 0 ? (
                data.foods.map((x) => (
                  <div key={x.id} className="item">
                    <div>
                      <b>{x.name}</b>
                      <br />
                      <span>
                        {x.meal}
                        {x.servings > 1 ? `・合菜 ÷ ${x.servings} 人` : ""}・{x.calories} kcal・蛋白 {x.protein}g／碳水 {x.carbs}g／脂肪 {x.fat}g
                      </span>
                    </div>
                    <div className="actions" style={{ margin: 0 }}>
                      {x.servings > 1 && !x.portionAdjusted && (
                        <button
                          className="ghost"
                          data-divide-food={x.id}
                          onClick={() => handleApplyPortionSharing(x.id)}
                        >
                          套用分食
                        </button>
                      )}
                      <button
                        className="danger"
                        data-food={x.id}
                        onClick={() => handleDeleteFood(x.id)}
                      >
                        刪除
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">今天尚無飲食紀錄</div>
              )}
            </div>
          </section>

          {/* Add Exercise Card */}
          <section className="card">
            <h2>🏃 新增運動</h2>
            <form id="exerciseForm" onSubmit={handleExerciseSubmit}>
              <div className="fields">
                <label>
                  運動項目
                  <select
                    id="exerciseName"
                    value={exerciseName}
                    onChange={(e) => setExerciseName(e.target.value)}
                  >
                    <option value="快走">快走</option>
                    <option value="跑步">跑步</option>
                    <option value="瑜伽">瑜伽</option>
                  </select>
                </label>
                <label>
                  時間 分鐘
                  <input
                    id="duration"
                    type="number"
                    min="1"
                    required
                    placeholder="輸入分鐘數"
                    value={exerciseDuration}
                    onChange={(e) => setExerciseDuration(e.target.value)}
                  />
                </label>
                <label>
                  預估消耗熱量 kcal
                  <input
                    id="exerciseCalories"
                    type="number"
                    readOnly
                    value={exerciseCalories}
                  />
                </label>
              </div>
              <div className="actions">
                <button type="submit">新增運動</button>
              </div>
            </form>

            {/* Exercise items listing */}
            <div id="exerciseList" className="list">
              {data.exercises.length > 0 ? (
                data.exercises.map((x) => (
                  <div key={x.id} className="item">
                    <div>
                      <b>{x.name}</b>
                      <br />
                      <span>{x.duration} 分鐘・消耗 {x.calories} kcal</span>
                    </div>
                    <button
                      className="danger"
                      data-exercise={x.id}
                      onClick={() => handleDeleteExercise(x.id)}
                    >
                      刪除
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty">今天尚無運動紀錄</div>
              )}
            </div>
          </section>

          {/* History Records Card */}
          <section className="card wide">
            <h2>🗂️ 本機歷史紀錄</h2>
            <div className="record-tools">
              <input
                id="recordName"
                placeholder="輸入快照名稱，例如：減脂第一週"
                value={recordName}
                onChange={(e) => setRecordName(e.target.value)}
              />
              <input
                id="recordSearch"
                placeholder="搜尋日期或名稱"
                value={recordSearch}
                onChange={(e) => setRecordSearch(e.target.value)}
              />
              <button id="saveSnapshot" className="pink" onClick={handleSaveSnapshot}>
                儲存命名快照
              </button>
            </div>
            <div className="notice">
              每次修改都會自動更新當日紀錄；命名快照可另外永久保留。紀錄數量不限制為 10 組，實際容量依瀏覽器而定。
            </div>
            <div id="recordCount" className="tag" style={{ marginTop: "12px" }}>
              共 {records.length} 組紀錄
              {recordSearch.trim() ? `・搜尋結果 ${filteredRecords.length} 組` : ""}
            </div>

            <div id="recordList" className="list">
              {filteredRecords.length > 0 ? (
                filteredRecords.map((r) => {
                  const s = r.snapshot || {};
                  const e = (s.foods || []).reduce((n, x) => n + x.calories, 0);
                  const b = (s.exercises || []).reduce((n, x) => n + x.calories, 0);
                  return (
                    <div key={r.id} className="item">
                      <div className="record-name">
                        <b>{r.name}</b>
                        <div className="record-meta">
                          <span className={`badge ${r.type === 'manual' ? 'manual' : ''}`}>
                            {r.type === 'manual' ? '命名快照' : '每日自動'}
                          </span>
                          <span>{s.date || ''}</span>
                          <span>攝取 {e}・運動 {b}・喝水 {s.water || 0}</span>
                        </div>
                      </div>
                      <div className="actions" style={{ margin: 0 }}>
                        <button
                          className="ghost"
                          data-record-load={r.id}
                          onClick={() => handleLoadRecord(r.id)}
                        >
                          載入
                        </button>
                        <button
                          className="danger"
                          data-record-delete={r.id}
                          onClick={() => handleDeleteRecord(r.id)}
                        >
                          刪除
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="empty">沒有符合的歷史紀錄</div>
              )}
            </div>
          </section>

          {/* Backup and Data Management */}
          <section className="card wide">
            <h2>📦 資料管理</h2>
            <div className="actions">
              <button id="exportData" onClick={handleExportData}>匯出完整備份 JSON</button>
              <button id="importBtn" className="ghost" onClick={() => importFileInputRef.current?.click()}>
                匯入完整備份
              </button>
              <input
                id="importFile"
                type="file"
                accept="application/json"
                style={{ display: "none" }}
                ref={importFileInputRef}
                onChange={handleImportFile}
              />
              <button id="saveCookie" className="ghost" onClick={saveCurrentToCookie}>儲存目前資料到 Cookie</button>
              <button id="loadCookie" className="ghost" onClick={loadCurrentFromCookie}>載入 Cookie</button>
              <button id="clearCookie" className="danger" onClick={removeCurrentCookie}>清除 Cookie</button>
              <button id="clearData" className="danger" onClick={handleClearAllData}>清除全部資料</button>
            </div>
            <div id="cookieStatus" className="status">{cookieStatus}</div>
            <div className="notice">
              Cookie 會保存目前資料與體重趨勢紀錄，但不包含本機歷史快照；若本機檔案不支援 Cookie 或容量超過限制，會自動改用本機替代儲存。換瀏覽器前仍建議匯出完整 JSON。
            </div>
          </section>
        </div>

        <div className="footer">本工具僅供日常紀錄，熱量與健康數據不取代醫師或營養師建議。</div>
      </main>
    </>
  );
}

