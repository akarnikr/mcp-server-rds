export type RefreshRdsCacheResult = {
  status: "ok";
  message: string;
};

export function refreshRdsCacheTool(): RefreshRdsCacheResult {
  return {
    status: "ok",
    message: "Phase 1 stub: refresh_rds_cache is registered.",
  };
}
