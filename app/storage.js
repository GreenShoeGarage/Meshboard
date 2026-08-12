import { defaultSettings, normalizeProject } from "./models.js";
const DB_NAME = "meshboard";
const DB_VERSION = 1;
const PROJECTS = "projects";
const META = "meta";
function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PROJECTS))
                db.createObjectStore(PROJECTS, { keyPath: "id" });
            if (!db.objectStoreNames.contains(META))
                db.createObjectStore(META);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
}
async function transaction(storeName, mode, fn) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const request = fn(tx.objectStore(storeName));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("IndexedDB operation failed"));
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
    }
    finally {
        db.close();
    }
}
export async function saveProject(project) {
    project.updatedAt = new Date().toISOString();
    await transaction(PROJECTS, "readwrite", store => store.put(project));
    await transaction(META, "readwrite", store => store.put(project.id, "currentProjectId"));
}
export async function loadCurrentProject() {
    const id = await transaction(META, "readonly", store => store.get("currentProjectId"));
    if (!id)
        return undefined;
    const value = await transaction(PROJECTS, "readonly", store => store.get(id));
    return value ? normalizeProject(value) : undefined;
}
export async function deleteProject(id) {
    await transaction(PROJECTS, "readwrite", store => store.delete(id));
}
export function loadSettings() {
    try {
        const raw = localStorage.getItem("meshboard.settings");
        return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
    }
    catch {
        return { ...defaultSettings };
    }
}
export function saveSettings(settings) {
    localStorage.setItem("meshboard.settings", JSON.stringify(settings));
}
export function estimateStorage() {
    return navigator.storage?.estimate?.() ?? Promise.resolve(undefined);
}
