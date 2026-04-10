export type RdsComponentRecord = {
  componentId: string;
  title: string;
  url: string;
};

export type ParsedComponentData = {
  componentId: string;
  url: string;
  sourceCode: string | null;
  installCommand: string | null;
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
  sections?: RdsSectionCacheData;
  themes?: {
    baseTheme: BaseThemeGuidelines;
  };
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

export type BaseThemeStoryGuideline = {
  storyId: string;
  title: string;
  name: string;
  url: string;
  iframeUrl: string;
  extractedText: string[];
  cssVariables: Record<string, string>;
  colors: string[];
  typographyFamilies: string[];
  warnings?: string[];
};

export type BaseThemeGuidelines = {
  updatedAt: string;
  sourceSite: string;
  sourceIndexUrl: string;
  storyCount: number;
  storyIds: string[];
  stories: BaseThemeStoryGuideline[];
  colorTokens: Record<string, string>;
  typographyTokens: Record<string, string>;
  spacingTokens: Record<string, string>;
  breakpoints: Record<string, string>;
  utilityClasses: string[];
  backgroundPatterns: string[];
  colorValues: string[];
  typographyFamilies: string[];
  notes: string[];
};

export type BaseThemeRunResult = {
  data: BaseThemeGuidelines;
  fromCache: boolean;
  usedStaleCache: boolean;
  warnings: string[];
  durationMs: number;
};

export type ThemeComplianceViolation = {
  type: "color" | "typography";
  property: string;
  value: string;
  element: string;
  message: string;
};

export type ThemeComplianceReport = {
  url: string;
  checkedAt: string;
  fromThemeCache: boolean;
  summary: {
    totalElementsScanned: number;
    totalViolations: number;
    score: number;
    compliant: boolean;
  };
  checks: Array<{
    id: string;
    status: "pass" | "fail";
    message: string;
  }>;
  violations: ThemeComplianceViolation[];
  warnings: string[];
  themeReference: {
    storyCount: number;
    storyIds: string[];
    updatedAt: string;
  };
};

export type RdsSectionRecord = {
  sectionId: string;
  title: string;
  category: string;
  docsUrl: string;
};

export type RdsSectionStoryRecord = {
  id: string;
  title: string;
  name: string;
  type: string;
  url: string;
};

export type RdsSectionDocsPayload = {
  storyId: string;
  url: string;
  sourceCode: string | null;
  propsColumns: string[];
  propsRows: Array<Record<string, string>>;
  warnings?: string[];
};

export type RdsSectionMetadata = {
  name: string;
  sectionId: string;
  category: "hero";
  description: string | null;
  docs: RdsSectionDocsPayload | null;
  stories: RdsSectionStoryRecord[];
  variants: {
    primary: { id: string; url: string } | null;
    examples: { id: string; url: string } | null;
  };
  sourceMeta: {
    indexJsonUrl: string;
    fetchedAt: string;
    fromCache: boolean;
  };
  metadataCompleteness: {
    score: number;
    missing: string[];
  };
  warnings: string[];
};

export type RdsSectionCacheData = {
  index: RdsSectionRecord[];
  detailsById: Record<string, RdsSectionMetadata>;
};

export type SectionRunResult = {
  data: RdsSectionCacheData;
  fromCache: boolean;
  usedStaleCache: boolean;
  warnings: string[];
  durationMs: number;
};
