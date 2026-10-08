/**
 * Gherkin (`.feature`) document translation.
 *
 * Unlike the markdown pipeline this module is deliberately small: a `.feature`
 * file is line-oriented, so a single-pass line classifier is enough. The output
 * is a plain-text document with a strict 1:1 line mapping to the source, which
 * keeps line numbers usable when reading the source and the translation
 * side by side.
 *
 * Three rules drive everything here:
 * 1. Gherkin keywords are localised by table lookup, never by machine
 *    translation — a translation engine returns a different word for `Given`
 *    every time it is asked, which makes a single file internally inconsistent.
 * 2. Tags, tables, placeholders and DocString bodies are reproduced verbatim.
 *    They are test data / bindings, not prose, and translating them only makes
 *    the document harder to line up against the real UI.
 * 3. Translatable lines are grouped into blank-line separated chunks and sent
 *    as one request per chunk, so the engine sees a whole scenario at once
 *    instead of isolated steps.
 */

/** Localised Gherkin keywords, keyed by target language. */
interface KeywordTable {
    feature: string;
    rule: string;
    background: string;
    scenarioOutline: string;
    scenario: string;
    examples: string;
    given: string;
    when: string;
    then: string;
    and: string;
    but: string;
}

/**
 * Keyword tables taken from the official Gherkin `gherkin-languages.json`
 * (first spelling of each keyword). Languages without an entry keep the
 * original English keywords.
 */
const KEYWORD_TABLES: Record<string, KeywordTable> = {
    'zh-CN': {
        feature: '功能',
        rule: '规则',
        background: '背景',
        scenarioOutline: '场景大纲',
        scenario: '场景',
        examples: '例子',
        given: '假如',
        when: '当',
        then: '那么',
        and: '而且',
        but: '但是',
    },
    'zh-TW': {
        feature: '功能',
        rule: '規則',
        background: '背景',
        scenarioOutline: '場景大綱',
        scenario: '場景',
        examples: '例子',
        given: '假如',
        when: '當',
        then: '那麼',
        and: '並且',
        but: '但是',
    },
    ja: {
        feature: '機能',
        rule: 'ルール',
        background: '背景',
        scenarioOutline: 'シナリオアウトライン',
        scenario: 'シナリオ',
        examples: '例',
        given: '前提',
        when: 'もし',
        then: 'ならば',
        and: 'かつ',
        but: 'しかし',
    },
    ko: {
        feature: '기능',
        rule: '규칙',
        background: '배경',
        scenarioOutline: '시나리오 개요',
        scenario: '시나리오',
        examples: '예',
        given: '조건',
        when: '만일',
        then: '그러면',
        and: '그리고',
        but: '하지만',
    },
};

/**
 * Look up the keyword table for a target language.
 * Falls back to the base language (`zh-CN` → `zh`) and finally to `undefined`,
 * which means "keep the English keywords".
 */
export function getKeywordTable(targetLanguage: string): KeywordTable | undefined {
    if (KEYWORD_TABLES[targetLanguage]) {
        return KEYWORD_TABLES[targetLanguage];
    }
    const base = targetLanguage.split('-')[0];
    const match = Object.keys(KEYWORD_TABLES).find(key => key.split('-')[0] === base);
    return match ? KEYWORD_TABLES[match] : undefined;
}

/** Block-level keywords, which are always followed by a colon. */
const BLOCK_KEYWORD_RE = /^(\s*)(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios)(:)(\s*)(.*)$/;

/** Step keywords, which are never followed by a colon. */
const STEP_KEYWORD_RE = /^(\s*)(Given|When|Then|And|But|\*)(\s+)(.*)$/;

/** A `# language: xx` header must stay untouched — it changes how Gherkin parses the file. */
const LANGUAGE_DIRECTIVE_RE = /^\s*#\s*language\s*:/i;

const COMMENT_RE = /^(\s*#\s*)(.*)$/;
const TAG_RE = /^\s*@/;
const TABLE_ROW_RE = /^\s*\|/;
const DOCSTRING_RE = /^\s*("""|```)/;
const PLACEHOLDER_RE = /<[^<>]*>/g;

/** Marker appended to lines whose translation has not arrived yet. */
export const PENDING_MARKER = ' ⟳';

/**
 * Delimiters used to hide `<placeholder>` tokens from the engine.
 *
 * Zero-width characters look like the obvious choice but translation engines
 * strip them, which loses the token entirely; these brackets are rare enough to
 * never appear in real prose and survive every engine tested.
 */
const SENTINEL_OPEN = '⟦';
const SENTINEL_CLOSE = '⟧';

/** One source line and how it should be rendered in the translated document. */
export interface FeatureLine {
    /** 0-based index in the source document */
    lineIndex: number;
    /** Raw source line, reproduced as-is when `translatable` is false */
    raw: string;
    /**
     * Verbatim head of the line: indentation plus the localised keyword and its
     * separator. Empty for description lines, `# ` for comments.
     */
    prefix: string;
    /** Natural-language text to translate; empty when there is nothing to translate */
    text: string;
    /** Whether `text` should be sent to the translation engine */
    translatable: boolean;
    /**
     * True for DocString fences and their bodies. Chunking ignores blank lines
     * inside such a block, so an embedded blank line in a JSON payload does not
     * cut the surrounding scenario in half.
     */
    verbatimBlock: boolean;
}

/**
 * Classify every line of a `.feature` document.
 *
 * DocString bodies are tracked with a small state machine so that blank lines
 * and `|`-leading lines inside a DocString are not mistaken for structure.
 */
export function parseFeatureLines(source: string, targetLanguage: string): FeatureLine[] {
    const table = getKeywordTable(targetLanguage);
    const lines = source.split('\n');
    const result: FeatureLine[] = [];

    /** Closing fence of the DocString currently open, or null when outside one. */
    let docStringFence: string | null = null;

    lines.forEach((raw, lineIndex) => {
        const verbatim = (verbatimBlock = false): FeatureLine =>
            ({ lineIndex, raw, prefix: raw, text: '', translatable: false, verbatimBlock });

        // ── Inside a DocString: everything is verbatim until the closing fence
        if (docStringFence !== null) {
            const close = raw.match(DOCSTRING_RE);
            if (close && close[1] === docStringFence) {
                docStringFence = null;
            }
            result.push(verbatim(true));
            return;
        }

        const openFence = raw.match(DOCSTRING_RE);
        if (openFence) {
            docStringFence = openFence[1];
            result.push(verbatim(true));
            return;
        }

        // ── Structural lines that are never translated
        if (!raw.trim() || TAG_RE.test(raw) || TABLE_ROW_RE.test(raw) || LANGUAGE_DIRECTIVE_RE.test(raw)) {
            result.push(verbatim());
            return;
        }

        // ── Comments: translate the text, keep the `#` marker
        const comment = raw.match(COMMENT_RE);
        if (comment) {
            const [, marker, body] = comment;
            result.push({
                lineIndex,
                raw,
                prefix: marker,
                text: body.trim(),
                translatable: body.trim().length > 0,
                verbatimBlock: false,
            });
            return;
        }

        // ── Block keywords: `Feature:`, `Scenario Outline:`, `Examples:` …
        const block = raw.match(BLOCK_KEYWORD_RE);
        if (block) {
            const [, indent, keyword, colon, spacing, rest] = block;
            const localised = table ? localiseBlockKeyword(keyword, table) : keyword;
            result.push({
                lineIndex,
                raw,
                prefix: `${indent}${localised}${colon}${spacing || (rest ? ' ' : '')}`,
                text: rest.trim(),
                translatable: rest.trim().length > 0,
                verbatimBlock: false,
            });
            return;
        }

        // ── Step keywords: `Given`, `When`, `Then`, `And`, `But`, `*`
        const step = raw.match(STEP_KEYWORD_RE);
        if (step) {
            const [, indent, keyword, spacing, rest] = step;
            const localised = table ? localiseStepKeyword(keyword, table) : keyword;
            result.push({
                lineIndex,
                raw,
                prefix: `${indent}${localised}${spacing}`,
                text: rest.trim(),
                translatable: rest.trim().length > 0,
                verbatimBlock: false,
            });
            return;
        }

        // ── Anything else is a free-form description line
        const indent = raw.match(/^\s*/)?.[0] ?? '';
        result.push({
            lineIndex,
            raw,
            prefix: indent,
            text: raw.trim(),
            translatable: true,
            verbatimBlock: false,
        });
    });

    return result;
}

function localiseBlockKeyword(keyword: string, table: KeywordTable): string {
    switch (keyword) {
        case 'Feature': return table.feature;
        case 'Rule': return table.rule;
        case 'Background': return table.background;
        case 'Scenario Outline':
        case 'Scenario Template': return table.scenarioOutline;
        case 'Scenario': return table.scenario;
        case 'Example':
        case 'Examples':
        case 'Scenarios': return table.examples;
        default: return keyword;
    }
}

function localiseStepKeyword(keyword: string, table: KeywordTable): string {
    switch (keyword) {
        case 'Given': return table.given;
        case 'When': return table.when;
        case 'Then': return table.then;
        case 'And': return table.and;
        case 'But': return table.but;
        default: return keyword;
    }
}

/**
 * Hide `<placeholder>` tokens behind sentinels so the engine cannot translate or
 * reorder them, then put them back afterwards.
 */
function protectPlaceholders(text: string): { protectedText: string; tokens: string[] } {
    const tokens: string[] = [];
    const protectedText = text.replace(PLACEHOLDER_RE, (match) => {
        const index = tokens.length;
        tokens.push(match);
        return `${SENTINEL_OPEN}${index}${SENTINEL_CLOSE}`;
    });
    return { protectedText, tokens };
}

/**
 * Put the protected tokens back.
 *
 * `ok` is false when the engine dropped or mangled a sentinel. The caller then
 * keeps the source text for that line: showing the original English step is
 * more useful than showing a translation with a placeholder missing from it.
 */
function restorePlaceholders(text: string, tokens: string[]): { text: string; ok: boolean } {
    let result = text;
    let ok = true;
    tokens.forEach((token, index) => {
        // Engines occasionally insert spaces around the sentinel digits.
        const pattern = new RegExp(`${SENTINEL_OPEN}\\s*${index}\\s*${SENTINEL_CLOSE}`);
        if (!pattern.test(result)) {
            ok = false;
            return;
        }
        result = result.replace(pattern, token);
    });
    return { text: result, ok };
}

/**
 * Group translatable line indices into blank-line separated chunks.
 *
 * A blank line ends the current chunk, which in normal Gherkin formatting makes
 * one chunk roughly one scenario. Blank lines inside a DocString are not
 * boundaries — a JSON payload with an empty line in it would otherwise split
 * the scenario it belongs to.
 */
export function buildFeatureChunks(lines: FeatureLine[]): number[][] {
    const chunks: number[][] = [];
    let current: number[] = [];

    for (const line of lines) {
        if (!line.raw.trim() && !line.verbatimBlock) {
            if (current.length) {
                chunks.push(current);
                current = [];
            }
            continue;
        }
        if (line.translatable) {
            current.push(line.lineIndex);
        }
    }
    if (current.length) {
        chunks.push(current);
    }
    return chunks;
}

/**
 * Render the translated document.
 *
 * `translations` is indexed by source line number: a string is the finished
 * translation, `null` means "still pending" and renders the original text with
 * {@link PENDING_MARKER}. Either way exactly one output line is produced per
 * source line.
 */
export function renderFeatureDocument(lines: FeatureLine[], translations: (string | null)[]): string {
    return lines.map((line) => {
        // `prefix` holds the whole line for verbatim lines, and the localised
        // keyword for keyword-only lines such as `Background:` / `Examples:`.
        if (!line.translatable) {
            return line.prefix;
        }
        const translated = translations[line.lineIndex];
        if (translated === null || translated === undefined) {
            return `${line.prefix}${line.text}${PENDING_MARKER}`;
        }
        return `${line.prefix}${translated}`;
    }).join('\n');
}

/**
 * Initial snapshot shown before any translation has come back: keywords are
 * already localised (they need no request) and prose still shows the source.
 */
export function buildFeatureLoadingSnapshot(source: string, targetLanguage: string): string {
    const lines = parseFeatureLines(source, targetLanguage);
    return renderFeatureDocument(lines, new Array(lines.length).fill(null));
}

/** How many chunk requests may be in flight at once. */
export const TRANSLATION_CONCURRENCY = 6;

/**
 * Run tasks with a bounded number in flight, preserving no particular order.
 * Rejections are the caller's responsibility — every task here handles its own.
 */
async function runWithConcurrency(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
    let next = 0;
    const workers = new Array(Math.min(limit, tasks.length)).fill(null).map(async () => {
        while (next < tasks.length) {
            const index = next++;
            await tasks[index]();
        }
    });
    await Promise.all(workers);
}

/**
 * Translate a `.feature` document chunk by chunk, reporting progress.
 *
 * Chunks are sent as newline-joined requests, up to
 * {@link TRANSLATION_CONCURRENCY} at a time. When the engine returns a
 * different number of lines than it was given, that chunk alone is retried line
 * by line, so a miscounted response degrades quality locally instead of
 * shifting the whole document out of alignment.
 *
 * Repeated lines — a `.feature` file is full of them, since the same step is
 * written in many scenarios — are requested only once and copied to every other
 * occurrence. That both removes requests and stops the same English step from
 * being rendered three different ways in one document.
 *
 * @param source          Raw `.feature` source
 * @param targetLanguage  Target language, used for keyword localisation
 * @param translateFn     Translation function
 * @param onProgress      Called with a full document snapshot after each chunk
 * @param previousResults Optional `sourceText → translatedText` map from a prior
 *                        run; matching lines are reused instead of re-requested
 */
export async function translateFeatureDocumentProgressive(
    source: string,
    targetLanguage: string,
    translateFn: (text: string) => Promise<string>,
    onProgress: (snapshot: string) => void,
    previousResults?: Map<string, string>,
): Promise<{ translated: string; resultsMap: Map<string, string> }> {
    const lines = parseFeatureLines(source, targetLanguage);
    const translations: (string | null)[] = new Array(lines.length).fill(null);
    const resultsMap = new Map<string, string>();

    /** Every line index that still shares each source text. */
    const occurrences = new Map<string, number[]>();

    // Reuse anything we already translated in a previous run for this document.
    let reused = false;
    for (const line of lines) {
        if (!line.translatable) {
            continue;
        }
        const previous = previousResults?.get(line.text);
        if (previous !== undefined) {
            translations[line.lineIndex] = previous;
            resultsMap.set(line.text, previous);
            reused = true;
            continue;
        }
        const seen = occurrences.get(line.text);
        if (seen) {
            seen.push(line.lineIndex);
        } else {
            occurrences.set(line.text, [line.lineIndex]);
        }
    }
    if (reused) {
        onProgress(renderFeatureDocument(lines, translations));
    }

    /** Only the first occurrence of a text is actually requested. */
    const isOwner = (lineIndex: number) => occurrences.get(lines[lineIndex].text)?.[0] === lineIndex;

    const chunks = buildFeatureChunks(lines)
        .map(chunk => chunk.filter(index => translations[index] === null && isOwner(index)))
        .filter(chunk => chunk.length > 0);

    if (chunks.length === 0) {
        const finalText = renderFeatureDocument(lines, translations);
        onProgress(finalText);
        return { translated: finalText, resultsMap };
    }

    /** Record a finished translation on every line that shares its source text. */
    const record = (text: string, translated: string) => {
        resultsMap.set(text, translated);
        for (const lineIndex of occurrences.get(text) ?? []) {
            translations[lineIndex] = translated;
        }
    };

    const tasks = chunks.map(chunk => async () => {
        const protectedTexts = chunk.map(index => protectPlaceholders(lines[index].text));

        let translatedTexts: string[] | null = null;
        try {
            const joined = protectedTexts.map(entry => entry.protectedText).join('\n');
            const response = await translateFn(joined);
            const responseLines = response.split('\n');
            // A mismatched line count means we cannot tell which translation
            // belongs to which line — fall back rather than guess.
            if (responseLines.length === chunk.length) {
                translatedTexts = responseLines;
            }
        } catch (error) {
            console.error('[CommentTranslate] Feature chunk translation failed:', error);
        }

        if (translatedTexts === null) {
            translatedTexts = await translateChunkLineByLine(protectedTexts.map(entry => entry.protectedText), translateFn);
        }

        chunk.forEach((lineIndex, position) => {
            const sourceText = lines[lineIndex].text;
            const restored = restorePlaceholders(translatedTexts![position].trim(), protectedTexts[position].tokens);
            record(sourceText, restored.ok ? restored.text : sourceText);
        });

        onProgress(renderFeatureDocument(lines, translations));
    });

    await runWithConcurrency(tasks, TRANSLATION_CONCURRENCY);

    return { translated: renderFeatureDocument(lines, translations), resultsMap };
}

/**
 * Fallback path for a chunk whose batched response could not be aligned.
 * A line that fails on its own keeps its source text.
 */
async function translateChunkLineByLine(
    texts: string[],
    translateFn: (text: string) => Promise<string>,
): Promise<string[]> {
    const results: string[] = [];
    for (const text of texts) {
        try {
            const translated = await translateFn(text);
            results.push(translated.split('\n')[0] ?? text);
        } catch (error) {
            console.error('[CommentTranslate] Feature line translation failed:', error);
            results.push(text);
        }
    }
    return results;
}
