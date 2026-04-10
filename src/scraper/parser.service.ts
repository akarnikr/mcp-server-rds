import { Injectable } from "@nestjs/common";

import type { ParsedComponentData, ScrapedPagePayload } from "./types.js";

@Injectable()
export class ParserService {
  toParsedData(payload: ScrapedPagePayload): ParsedComponentData {
    return {
      componentId: payload.componentId,
      url: payload.url,
      sourceCode: null,
      propsColumns: [],
      propsRows: [],
      warnings: [
        "Phase 2 placeholder: parser extraction is implemented in Phase 3.",
      ],
    };
  }
}
