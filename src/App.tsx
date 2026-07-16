import React, { useState, useEffect, useRef } from "react";

// LocalStorage and DB keys matching original safe version
const KEY = 'shine_body_standalone_v1';
const COOKIE_NAME = 'shine_body_current';
const COOKIE_FALLBACK_KEY = 'shine_body_cookie_fallback';
const AI_PROVIDER_STORE = 'shine_body_ai_provider';
const AI_PROVIDER_MIGRATION = 'shine_body_ai_provider_v2';
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

interface FoodChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface FoodSearchSource {
  title: string;
  url: string;
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
}

interface SnapshotRecord {
  id: string;
  name: string;
  type: 'daily' | 'manual';
  createdAt: string;
  snapshot: AppData;
}

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
  exercises: []
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
  const [aiProvider, setAiProvider] = useState(() => {
    const providerMigrated = localStorage.getItem(AI_PROVIDER_MIGRATION);
    if (providerMigrated) {
      return localStorage.getItem(AI_PROVIDER_STORE) || 'gemini';
    }
    localStorage.setItem(AI_PROVIDER_STORE, 'gemini');
    localStorage.setItem(AI_PROVIDER_MIGRATION, '1');
    return 'gemini';
  });
  const [shareCount, setShareCount] = useState<number>(1);
  const [selectedPhoto, setSelectedPhoto] = useState<{ dataUrl: string; base64: string; mimeType: string } | null>(null);
  const [aiStatus, setAiStatus] = useState("每位朋友的紀錄只保存在自己的瀏覽器；AI 結果僅為估算。");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [lastAiFood, setLastAiFood] = useState<any>(null);
  const [foodPrompt, setFoodPrompt] = useState("");
  const [foodConversation, setFoodConversation] = useState<FoodChatMessage[]>([]);
  const [foodSearchSources, setFoodSearchSources] = useState<FoodSearchSource[]>([]);
  const [isSearchingFood, setIsSearchingFood] = useState(false);

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
            const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
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
  const recalculateAiPortion = (aiFood: any, people: number) => {
    if (!aiFood) return;
    const divide = (value: any) => Math.round((Math.max(0, Number(value) || 0) / people) * 10) / 10;
    
    setFoodName(aiFood.foodName || aiFood.name || '');
    setFoodCalories(String(Math.round(divide(aiFood.calories))));
    setFoodProtein(String(divide(aiFood.protein)));
    setFoodCarbs(String(divide(aiFood.carbs)));
    setFoodFat(String(divide(aiFood.fat)));
    
    setAiStatus(`Gemini AI 分析完成：整份共 ${Math.round(Number(aiFood.calories) || 0)} kcal${people > 1 ? `，除以 ${people} 人後每人約 ${Math.round(divide(aiFood.calories))} kcal` : '，目前未分食'}。${aiFood.description || '請確認數字後再新增。'}`);
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
    setAiStatus("Gemini 正在透過安全伺服器分析…");

    try {
      const response = await fetch("/api/analyze-food", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: selectedPhoto.base64,
          mimeType: selectedPhoto.mimeType,
          provider: aiProvider,
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
      recalculateAiPortion(result.food, shareCount);

    } catch (error: any) {
      console.error(error);
      setAiStatus(`分析失敗：${error.message || error}。可稍後再試或手動輸入。`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFoodTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = foodPrompt.trim();
    if (!message || isSearchingFood) return;

    const nextConversation: FoodChatMessage[] = [
      ...foodConversation,
      { role: 'user', content: message }
    ];
    setFoodConversation(nextConversation);
    setFoodPrompt("");
    setIsSearchingFood(true);
    setAiStatus("正在搜尋相關商品與營養資料…");

    try {
      const response = await fetch("/api/analyze-food-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: foodConversation })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);

      setFoodSearchSources(Array.isArray(result.sources) ? result.sources : []);
      if (result.status === 'clarify') {
        const question = result.question || "可以再說明份量嗎？";
        setFoodConversation([...nextConversation, { role: 'assistant', content: question }]);
        setAiStatus("需要你補充一點資訊；也可以回答「直接估」讓我用常見份量估算。");
        return;
      }

      if (!result.food) throw new Error("沒有取得可用的估算結果");
      setLastAiFood(result.food);
      recalculateAiPortion(result.food, shareCount);
      const confidenceLabel = result.confidence === 'high' ? '高' : result.confidence === 'low' ? '低' : '中';
      const answer = `${result.food.name}：約 ${result.food.calories} kcal。${result.food.description || ''}`;
      setFoodConversation([...nextConversation, { role: 'assistant', content: answer }]);
      setAiStatus(`網路搜尋估算完成（可信度：${confidenceLabel}）。數字已帶入下方，請確認後按「新增飲食」。`);
    } catch (error: any) {
      setFoodConversation([...nextConversation, { role: 'assistant', content: `目前無法完成搜尋：${error.message || error}` }]);
      setAiStatus("搜尋失敗，可再試一次或直接手動輸入。");
    } finally {
      setIsSearchingFood(false);
    }
  };

  // Add food submit
  const handleFoodSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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
    setFoodPrompt("");
    setFoodConversation([]);
    setFoodSearchSources([]);
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

  return (
    <>
      <header>
        <h1>✨ 閃耀體態</h1>
        <p>飲食卡路里管家・AI 智能升級版</p>
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
            <div className="ai-box food-text-box">
              <b>🔎 用一句話搜尋熱量</b>
              <p className="ai-hint">輸入品牌商品或一般餐點；資料不夠時，我會先問你一個問題。</p>
              <form onSubmit={handleFoodTextSubmit}>
                <div className="food-prompt-row">
                  <textarea
                    aria-label="描述你吃了什麼"
                    rows={2}
                    maxLength={500}
                    placeholder="例如：我吃了 7-11 阜杭豆漿飯糰／雞胸肉便當"
                    value={foodPrompt}
                    onChange={(e) => setFoodPrompt(e.target.value)}
                  />
                  <button className="pink" type="submit" disabled={!foodPrompt.trim() || isSearchingFood}>
                    {isSearchingFood ? "搜尋中…" : foodConversation.length ? "送出回答" : "搜尋估算"}
                  </button>
                </div>
              </form>
              {foodConversation.length > 0 && (
                <div className="food-chat" aria-live="polite">
                  {foodConversation.map((message, index) => (
                    <div key={`${message.role}-${index}`} className={`food-chat-message ${message.role}`}>
                      <span>{message.role === 'user' ? '你' : 'AI'}</span>
                      <p>{message.content}</p>
                    </div>
                  ))}
                </div>
              )}
              {foodSearchSources.length > 0 && (
                <div className="food-sources">
                  <span>參考資料：</span>
                  {foodSearchSources.map((source) => (
                    <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
                  ))}
                </div>
              )}
            </div>
            <div className="ai-box">
              <b>✨ AI 照片分析</b>
              <div className="fields" style={{ marginTop: "9px" }}>
                <label>
                  AI 服務
                  <select
                    id="aiProvider"
                    value={aiProvider}
                    onChange={(e) => {
                      setAiProvider(e.target.value);
                      localStorage.setItem(AI_PROVIDER_STORE, e.target.value);
                      setAiStatus(`已切換為 ${e.target.value === 'gemini' ? 'Gemini AI' : 'OpenRouter 免費 Vision'}。`);
                    }}
                  >
                    <option value="gemini">Gemini</option>
                    <option value="openrouter">OpenRouter 免費 Vision (模擬轉向)</option>
                  </select>
                </label>
                <label>
                  選擇或拍攝食物照片
                  <input
                    id="foodPhoto"
                    type="file"
                    accept="image/*"
                    capture="environment"
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
              Cookie 只保存目前資料，不包含完整歷史；若本機檔案不支援 Cookie 或容量超過限制，會自動改用本機替代儲存。換瀏覽器前仍建議匯出完整 JSON。
            </div>
          </section>
        </div>

        <div className="footer">本工具僅供日常紀錄，熱量與健康數據不取代醫師或營養師建議。</div>
      </main>
    </>
  );
}

