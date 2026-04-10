export type RdsComponentRecord = {
  componentId: string;
  title: string;
  url: string;
};

export type ParsedComponentData = {
  componentId: string;
  url: string;
  sourceCode: string | null;
  propsColumns: string[];
  propsRows: Array<Record<string, string>>;
  warnings?: string[];
};

export type CachedRdsData = {
  schemaVersion: number;
  updatedAt: string;
  sourceSite: string;
  components: RdsComponentRecord[];
  detailsById: Record<string, ParsedComponentData>;
};

export type ScrapeRunResult = {
  data: CachedRdsData;
  fromCache: boolean;
  usedStaleCache: boolean;
  warnings: string[];
  durationMs: number;
};

export type ScrapedPagePayload = {
  componentId: string;
  url: string;
  html: string;
};
