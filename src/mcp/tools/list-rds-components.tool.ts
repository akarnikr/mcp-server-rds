export type ListRdsComponentsResult = {
  status: "ok";
  message: string;
};

export function listRdsComponentsTool(): ListRdsComponentsResult {
  return {
    status: "ok",
    message: "Phase 1 stub: list_rds_components is registered.",
  };
}
