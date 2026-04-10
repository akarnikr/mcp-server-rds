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

export type RdsStoryRecord = {
  id: string;
  title: string;
  url: string;
  type: string;
};

export type RdsComponentMetadata = {
  name: string;
  package: string | null;
  version: string | null;
  description: string | null;
  category: string | null;
  props: Array<Record<string, string>>;
  events: Array<Record<string, string>>;
  slots: Array<Record<string, string>>;
  stories: RdsStoryRecord[];
  peerDependencies: Record<string, string>;
  lastPublished: string | null;
  importStatement: string | null;
  installCommand: string | null;
  sourceMeta: {
    docsUrl: string | null;
    indexJsonUrl: string;
    npmRegistryUrl: string | null;
    fetchedAt: string;
    fromCache: boolean;
  };
  metadataCompleteness: {
    score: number;
    missing: string[];
  };
  warnings: string[];
};
