import { isTauri } from "@tauri-apps/api/core";

export const isWeb = typeof window !== "undefined" && !isTauri();
