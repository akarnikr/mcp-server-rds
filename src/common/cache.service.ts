import { Injectable } from "@nestjs/common";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { CachedRdsData } from "../scraper/types.js";

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "rds-data.json");
const CURRENT_CACHE_SCHEMA_VERSION = 3;

@Injectable()
export class CacheService {
  get cachePath(): string {
    return CACHE_FILE;
  }

  async readCache(): Promise<CachedRdsData | null> {
    try {
      const raw = await fs.readFile(CACHE_FILE, "utf-8");
      return JSON.parse(raw) as CachedRdsData;
    } catch (error) {
      if (this.isNotFound(error)) {
        return null;
      }
      console.error("Failed to read cache file:", error);
      return null;
    }
  }

  async writeCache(data: CachedRdsData): Promise<void> {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (error) {
      console.error("Failed to write cache file:", error);
      throw error;
    }
  }

  isFresh(updatedAtIso: string, ttlHours = 24): boolean {
    const updatedAtMs = Date.parse(updatedAtIso);
    if (Number.isNaN(updatedAtMs)) {
      return false;
    }

    const ttlMs = ttlHours * 60 * 60 * 1000;
    return Date.now() - updatedAtMs < ttlMs;
  }

  async getFreshCache(ttlHours = 24): Promise<CachedRdsData | null> {
    const cache = await this.readCache();
    if (!cache) {
      return null;
    }
    if (cache.schemaVersion !== CURRENT_CACHE_SCHEMA_VERSION) {
      return null;
    }

    return this.isFresh(cache.updatedAt, ttlHours) ? cache : null;
  }

  private isNotFound(error: unknown): error is NodeJS.ErrnoException {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }
}
