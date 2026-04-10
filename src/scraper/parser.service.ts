import { Injectable } from "@nestjs/common";
import { load } from "cheerio";

import type { ParsedComponentData, ScrapedPagePayload } from "./types.js";

@Injectable()
export class ParserService {
  toParsedData(payload: ScrapedPagePayload): ParsedComponentData {
    const $ = load(payload.html);
    const warnings: string[] = [];

    const { sourceCode, sourceWarning } = this.extractSourceCode($);
    if (sourceWarning) {
      warnings.push(sourceWarning);
    }

    const { propsColumns, propsRows, propsWarning } = this.extractPropsTable($);
    if (propsWarning) {
      warnings.push(propsWarning);
    }

    const { installCommand, installWarning } = this.extractInstallCommand($);
    if (installWarning) {
      warnings.push(installWarning);
    }

    return {
      componentId: payload.componentId,
      url: payload.url,
      sourceCode,
      installCommand,
      propsColumns,
      propsRows,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private extractSourceCode($: ReturnType<typeof load>): {
    sourceCode: string | null;
    sourceWarning?: string;
  } {
    const preNodes = $("pre").toArray();
    const candidates = preNodes
      .map((preNode) => {
        const codeNode = $(preNode).find("code").first();
        const textSource = codeNode.length > 0 ? codeNode.text() : $(preNode).text();
        const text = this.cleanText(textSource);
        const codeClass = codeNode.attr("class") ?? "";
        const preClass = $(preNode).attr("class") ?? "";
        const dataLang = codeNode.attr("data-language") ?? $(preNode).attr("data-language") ?? "";
        return { text, codeClass, preClass, dataLang };
      })
      .filter((candidate) => candidate.text.length > 0);

    if (candidates.length === 0) {
      return {
        sourceCode: null,
        sourceWarning: "No non-empty code block found on the component page.",
      };
    }

    const preferred = candidates.find((candidate) => {
      const className = candidate.codeClass.toLowerCase();
      const preClass = candidate.preClass.toLowerCase();
      const dataLang = candidate.dataLang.toLowerCase();
      return (
        className.includes("vue") || preClass.includes("vue") || dataLang === "vue"
      );
    });

    if (!preferred) {
      const fallback = candidates[0].text;
      const looksLikeVue =
        fallback.includes("<template") ||
        fallback.includes("</template>") ||
        fallback.includes(" v-");
      return {
        sourceCode: fallback,
        sourceWarning: looksLikeVue
          ? undefined
          : "No Vue-labeled code block found; returned first code block.",
      };
    }

    return {
      sourceCode: preferred.text,
    };
  }

  private extractPropsTable($: ReturnType<typeof load>): {
    propsColumns: string[];
    propsRows: Array<Record<string, string>>;
    propsWarning?: string;
  } {
    const tables = $("table").toArray();
    if (tables.length === 0) {
      return {
        propsColumns: [],
        propsRows: [],
        propsWarning: "No props table found on the component page.",
      };
    }

    const scored = tables
      .map((table) => {
        const headers = $(table)
          .find("thead th")
          .toArray()
          .map((th) => this.cleanText($(th).text()));

        const normalized = headers.map((header) => header.toLowerCase());
        const score = normalized.reduce((total, header) => {
          if (
            header.includes("prop") ||
            header.includes("name") ||
            header.includes("type") ||
            header.includes("default") ||
            header.includes("description")
          ) {
            return total + 1;
          }
          return total;
        }, 0);

        return { table, headers, score };
      })
      .sort((a, b) => b.score - a.score);

    const selected = scored[0];
    let columns = selected.headers;
    if (columns.length === 0) {
      columns = $(selected.table)
        .find("tr")
        .first()
        .find("th,td")
        .toArray()
        .map((cell) => this.cleanText($(cell).text()))
        .filter(Boolean);
    }

    if (columns.length === 0) {
      return {
        propsColumns: [],
        propsRows: [],
        propsWarning: "A table was found, but no readable props columns were detected.",
      };
    }

    const rows = $(selected.table).find("tbody tr").toArray();
    const rowNodes = rows.length > 0 ? rows : $(selected.table).find("tr").slice(1).toArray();
    const propsRows = rowNodes
      .map((row) => {
        const cells = $(row)
          .find("td")
          .toArray()
          .map((cell) => this.cleanText($(cell).text()));
        if (cells.length === 0) {
          return null;
        }

        const record: Record<string, string> = {};
        for (let index = 0; index < columns.length; index += 1) {
          const key = columns[index] || `column_${index + 1}`;
          record[key] = cells[index] ?? "";
        }
        return record;
      })
      .filter((record): record is Record<string, string> => Boolean(record));

    return {
      propsColumns: columns,
      propsRows,
      propsWarning:
        propsRows.length === 0
          ? "Props table detected, but no data rows were parsed."
          : undefined,
    };
  }

  private extractInstallCommand($: ReturnType<typeof load>): {
    installCommand: string | null;
    installWarning?: string;
  } {
    const fromInstallSection = this.extractInstallCommandFromInstallSection($);
    if (fromInstallSection) {
      return { installCommand: fromInstallSection };
    }

    const fallbackCandidates = $("pre, pre code, code")
      .toArray()
      .map((node) => this.cleanText($(node).text()))
      .filter(Boolean)
      .filter((text) => this.looksLikeInstallCommand(text));

    if (fallbackCandidates.length > 0) {
      return {
        installCommand: fallbackCandidates[0],
        installWarning:
          "Install command inferred from code blocks outside explicit Install section.",
      };
    }

    return {
      installCommand: null,
      installWarning: "No install command found in docs page.",
    };
  }

  private extractInstallCommandFromInstallSection(
    $: ReturnType<typeof load>,
  ): string | null {
    const headings = $("h1, h2, h3, h4, h5, h6").toArray();
    const installHeading = headings.find((heading) => {
      const text = this.cleanText($(heading).text()).toLowerCase();
      return text === "install" || text.startsWith("install ");
    });

    if (!installHeading) {
      return null;
    }

    const commandFromSiblings = $(installHeading)
      .nextAll()
      .toArray()
      .flatMap((node) =>
        $(node)
          .find("pre, pre code, code")
          .toArray()
          .map((codeNode) => this.cleanText($(codeNode).text())),
      )
      .find((text) => this.looksLikeInstallCommand(text));

    if (commandFromSiblings) {
      return commandFromSiblings;
    }

    const commandFromClosestSection = $(installHeading)
      .parent()
      .find("pre, pre code, code")
      .toArray()
      .map((node) => this.cleanText($(node).text()))
      .find((text) => this.looksLikeInstallCommand(text));

    return commandFromClosestSection ?? null;
  }

  private looksLikeInstallCommand(text: string): boolean {
    const candidate = text.toLowerCase();
    return (
      (candidate.startsWith("npm install") ||
        candidate.startsWith("npm i ") ||
        candidate.startsWith("yarn add ") ||
        candidate.startsWith("pnpm add ") ||
        candidate.startsWith("bun add ")) &&
      (candidate.includes("@rds-vue-ui/") || candidate.includes("rds-vue-ui"))
    );
  }

  private cleanText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }
}
