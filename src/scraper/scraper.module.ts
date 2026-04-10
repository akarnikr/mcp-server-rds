import { Module } from "@nestjs/common";

import { CacheService } from "../common/cache.service.js";
import { ParserService } from "./parser.service.js";
import { ScraperService } from "./scraper.service.js";

@Module({
  providers: [ScraperService, ParserService, CacheService],
  exports: [ScraperService, ParserService, CacheService],
})
export class ScraperModule {}
