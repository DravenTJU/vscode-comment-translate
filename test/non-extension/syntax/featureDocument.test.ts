import {
    parseFeatureLines,
    buildFeatureChunks,
    renderFeatureDocument,
    buildFeatureLoadingSnapshot,
    translateFeatureDocumentProgressive,
    getKeywordTable,
    PENDING_MARKER,
    TRANSLATION_CONCURRENCY,
} from "../../../src/syntax/featureDocument";
import { promises as fsPromises } from "fs";
import * as path from "path";

function readFixture(name: string): Promise<string> {
    return fsPromises.readFile(path.resolve(__dirname, "../../fixtures/", name), "utf-8");
}

const TARGET = "zh-CN";

/** Translate stub: marks the text so assertions can see it round-tripped. */
async function fakeTranslate(text: string): Promise<string> {
    return text.split("\n").map(line => `[${line}]`).join("\n");
}

describe("getKeywordTable", () => {
    it("resolves an exact language tag", () => {
        expect(getKeywordTable("zh-CN")?.given).toBe("假如");
    });

    it("falls back to the base language", () => {
        expect(getKeywordTable("ja-JP")?.given).toBe("前提");
    });

    it("returns undefined for languages without a table", () => {
        expect(getKeywordTable("de")).toBeUndefined();
    });
});

describe("parseFeatureLines", () => {
    it("localises block keywords and keeps the title translatable", () => {
        const [line] = parseFeatureLines("Feature: Tender submission", TARGET);
        expect(line.prefix).toBe("功能: ");
        expect(line.text).toBe("Tender submission");
        expect(line.translatable).toBe(true);
    });

    it("localises step keywords while preserving indentation", () => {
        const [line] = parseFeatureLines("    Given I am logged in", TARGET);
        expect(line.prefix).toBe("    假如 ");
        expect(line.text).toBe("I am logged in");
    });

    it("keeps English keywords when the target language has no table", () => {
        const [line] = parseFeatureLines("  When I click", "de");
        expect(line.prefix).toBe("  When ");
    });

    it("localises a keyword-only line without marking it translatable", () => {
        const [line] = parseFeatureLines("  Background:", TARGET);
        expect(line.prefix).toBe("  背景:");
        expect(line.translatable).toBe(false);
    });

    it("never translates tags, tables or the language directive", () => {
        const lines = parseFeatureLines(
            "# language: zh-CN\n@smoke @tender\n      | tenderName |\n      | Milk Q3    |",
            TARGET,
        );
        expect(lines.every(line => !line.translatable)).toBe(true);
        expect(lines.map(line => line.raw)).toEqual([
            "# language: zh-CN",
            "@smoke @tender",
            "      | tenderName |",
            "      | Milk Q3    |",
        ]);
    });

    it("translates comments but keeps the marker", () => {
        const [line] = parseFeatureLines("  # A scenario with a payload", TARGET);
        expect(line.prefix).toBe("  # ");
        expect(line.text).toBe("A scenario with a payload");
        expect(line.translatable).toBe(true);
    });

    it("treats a DocString body as verbatim, including blank lines inside it", () => {
        const source = [
            '    When I post the payload',
            '      """',
            '      {',
            '',
            '        "currency": "NZD"',
            '      }',
            '      """',
            '    Then the response status should be 400',
        ].join("\n");
        const lines = parseFeatureLines(source, TARGET);
        expect(lines.filter(line => line.translatable).map(line => line.text)).toEqual([
            "I post the payload",
            "the response status should be 400",
        ]);
    });

    it("translates free-form description lines whole", () => {
        const lines = parseFeatureLines("Feature: X\n  As a supplier I want to submit", TARGET);
        expect(lines[1].prefix).toBe("  ");
        expect(lines[1].text).toBe("As a supplier I want to submit");
        expect(lines[1].translatable).toBe(true);
    });
});

describe("buildFeatureChunks", () => {
    it("splits on blank lines and skips non-translatable lines", () => {
        const source = [
            "Feature: A",         // 0 translatable
            "  Description",      // 1 translatable
            "",                   // 2 blank
            "  Scenario: B",      // 3 translatable
            "    Given x",        // 4 translatable
            "",                   // 5 blank
            "    Examples:",      // 6 keyword only
            "      | a |",        // 7 table
        ].join("\n");
        const lines = parseFeatureLines(source, TARGET);
        expect(buildFeatureChunks(lines)).toEqual([[0, 1], [3, 4]]);
    });

    it("does not split inside a DocString", () => {
        const source = [
            "    Given x",
            '      """',
            "      a",
            "",
            "      b",
            '      """',
            "    Then y",
        ].join("\n");
        const lines = parseFeatureLines(source, TARGET);
        expect(buildFeatureChunks(lines)).toEqual([[0, 6]]);
    });
});

describe("renderFeatureDocument", () => {
    it("keeps a strict 1:1 line mapping with the source", async () => {
        const source = await readFixture("tender.feature");
        const lines = parseFeatureLines(source, TARGET);
        const rendered = renderFeatureDocument(lines, new Array(lines.length).fill(null));
        expect(rendered.split("\n").length).toBe(source.split("\n").length);
    });

    it("localises keyword-only lines that have nothing to translate", () => {
        const lines = parseFeatureLines("  Background:\n    Examples:", TARGET);
        expect(renderFeatureDocument(lines, [null, null])).toBe("  背景:\n    例子:");
    });

    it("reproduces tags, tables and DocString bodies byte for byte", () => {
        const source = ['@smoke', '  | a | b |', '  """', '  {}', '  """'].join("\n");
        const lines = parseFeatureLines(source, TARGET);
        expect(renderFeatureDocument(lines, new Array(lines.length).fill(null))).toBe(source);
    });

    it("marks pending lines and renders finished ones", () => {
        const lines = parseFeatureLines("Feature: A\n  Given x", TARGET);
        const rendered = renderFeatureDocument(lines, ["甲", null]);
        expect(rendered).toBe(`功能: 甲\n  假如 x${PENDING_MARKER}`);
    });
});

describe("buildFeatureLoadingSnapshot", () => {
    it("localises keywords immediately and leaves prose pending", () => {
        const snapshot = buildFeatureLoadingSnapshot("Feature: Tender\n  Given x", TARGET);
        expect(snapshot).toBe(`功能: Tender${PENDING_MARKER}\n  假如 x${PENDING_MARKER}`);
    });
});

describe("translateFeatureDocumentProgressive", () => {
    it("sends one request per blank-line chunk", async () => {
        const translate = jest.fn(fakeTranslate);
        const source = await readFixture("tender.feature");
        await translateFeatureDocumentProgressive(source, TARGET, translate, () => { /* noop */ });
        // Chunks: feature+description, background, scenario outline, comment+scenario+steps
        expect(translate).toHaveBeenCalledTimes(4);
    });

    it("protects <placeholder> tokens from the engine", async () => {
        const seen: string[] = [];
        const translate = async (text: string) => {
            seen.push(text);
            return fakeTranslate(text);
        };
        const { translated } = await translateFeatureDocumentProgressive(
            '    When I open the tender "<tenderName>"',
            TARGET,
            translate,
            () => { /* noop */ },
        );
        expect(seen[0]).not.toContain("<tenderName>");
        expect(translated).toContain("<tenderName>");
    });

    it("keeps the source line when the engine drops a placeholder sentinel", async () => {
        // Mimics an engine that strips the sentinel brackets, losing the token.
        const translate = async (text: string) => text.replace(/[\u27E6\u27E7]/g, "");
        const { translated } = await translateFeatureDocumentProgressive(
            '    When I open the tender "<tenderName>"',
            TARGET,
            translate,
            () => { /* noop */ },
        );
        expect(translated).toBe('    \u5f53 I open the tender "<tenderName>"');
    });

    it("falls back to line-by-line when the response line count does not match", async () => {
        const calls: string[] = [];
        const translate = async (text: string) => {
            calls.push(text);
            // Collapse a multi-line request into one line to force a mismatch.
            return text.includes("\n") ? "collapsed" : `[${text}]`;
        };
        const source = "Feature: A\n  Given x\n  Then y";
        const { translated } = await translateFeatureDocumentProgressive(
            source,
            TARGET,
            translate,
            () => { /* noop */ },
        );
        // One batched attempt plus one request per line.
        expect(calls.length).toBe(4);
        expect(translated).toBe("功能: [A]\n  假如 [x]\n  那么 [y]");
    });

    it("keeps the source text for a line whose translation throws", async () => {
        const translate = async (text: string) => {
            if (text.includes("\n")) {
                throw new Error("batch failed");
            }
            throw new Error("line failed");
        };
        const { translated } = await translateFeatureDocumentProgressive(
            "Feature: A\n  Given x",
            TARGET,
            translate,
            () => { /* noop */ },
        );
        expect(translated).toBe("功能: A\n  假如 x");
    });

    it("reuses previous results instead of re-requesting unchanged lines", async () => {
        const translate = jest.fn(fakeTranslate);
        const previous = new Map([["A", "甲"]]);
        const { translated, resultsMap } = await translateFeatureDocumentProgressive(
            "Feature: A\n  Given x",
            TARGET,
            translate,
            () => { /* noop */ },
            previous,
        );
        expect(translated).toBe("功能: 甲\n  假如 [x]");
        expect(translate).toHaveBeenCalledTimes(1);
        expect(translate).toHaveBeenCalledWith("x");
        expect(resultsMap.get("A")).toBe("甲");
    });

    it("requests a repeated line only once and reuses it everywhere", async () => {
        const seen: string[] = [];
        const translate = async (text: string) => {
            seen.push(text);
            return text.split("\n").map(line => `[${line}]`).join("\n");
        };
        const source = [
            "  Scenario: A",
            "    Given I open the panel",
            "",
            "  Scenario: B",
            "    Given I open the panel",
            "    Then I see it",
        ].join("\n");
        const { translated } = await translateFeatureDocumentProgressive(source, TARGET, translate, () => { /* noop */ });
        // The repeated step is absent from the second chunk's request.
        expect(seen).toEqual(["A\nI open the panel", "B\nI see it"]);
        // …but still rendered, with exactly the same translation as the first.
        expect(translated.split("\n")[4]).toBe("    \u5047\u5982 [I open the panel]");
    });

    it("runs chunks concurrently rather than one after another", async () => {
        let inFlight = 0;
        let peak = 0;
        const translate = async (text: string) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise(resolve => setTimeout(resolve, 5));
            inFlight--;
            return text;
        };
        // Ten single-step scenarios, each its own blank-line separated chunk.
        const source = Array.from({ length: 10 }, (_, i) => `  Scenario: S${i}\n    Given step ${i}`).join("\n\n");
        await translateFeatureDocumentProgressive(source, TARGET, translate, () => { /* noop */ });
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(TRANSLATION_CONCURRENCY);
    });

    it("reports progress after every chunk", async () => {
        const snapshots: string[] = [];
        await translateFeatureDocumentProgressive(
            "Feature: A\n\n  Given x",
            TARGET,
            fakeTranslate,
            (snapshot) => snapshots.push(snapshot),
        );
        expect(snapshots.length).toBe(2);
        expect(snapshots[0]).toBe(`功能: [A]\n\n  假如 x${PENDING_MARKER}`);
        expect(snapshots[1]).toBe("功能: [A]\n\n  假如 [x]");
    });
});
