import { ITranslateOptions } from 'comment-translate-manager';
import { getConfig } from '../configuration';
import { BaseTranslate } from './baseTranslate';

/**
 * Translation through any OpenAI-compatible `/chat/completions` endpoint.
 *
 * The prompt asks for a strictly line-preserving translation. That matters far
 * more here than it looks: callers such as the `.feature` view send several
 * lines in one request and match the reply back to the source line by line, so
 * a reply that merges two lines into one costs a whole retry.
 *
 * Deliberately absent from the request body:
 * - `max_tokens`, so long replies are never truncated mid-document, and so
 *   endpoints that renamed the field (`max_completion_tokens`) do not reject it
 * - `frequency_penalty` / `presence_penalty`, which penalise reusing a word and
 *   therefore push the model to translate the same term differently each time
 *   it appears — the opposite of what technical text needs
 *
 * `extraRequestParams` is merged into the body last, so a gateway that needs a
 * field of its own can have one without a code change.
 */
export abstract class OpenAICompatibleTranslate extends BaseTranslate {

    maxLen = 5000;

    /** Configuration namespace under `commentTranslate.` holding this source's settings. */
    protected abstract get configPrefix(): string;

    protected abstract get defaultBaseUrl(): string;

    protected abstract get defaultModel(): string;

    /** Human-readable name used in error messages. */
    protected abstract get displayName(): string;

    private config<T>(key: string, defaultValue: T): T {
        return getConfig<T>(`${this.configPrefix}.${key}`, defaultValue);
    }

    /** Endpoint URL. `apiBaseUrl` is expected to include any `/v1` prefix. */
    private get endpoint(): string {
        const base = this.config('apiBaseUrl', this.defaultBaseUrl).replace(/\/+$/, '');
        return `${base}/chat/completions`;
    }

    private buildMessages(content: string, to: string) {
        const system = [
            `You are a translation engine. Translate the user's text into ${to}.`,
            'Output the translation only: no explanations, no quotes around the result, no code fences.',
            'The input may contain several lines. Translate each line separately and output exactly the same number of lines, in the same order. Never merge, split, reorder or drop a line. A line that needs no translation is repeated unchanged.',
            'Copy every ⟦0⟧-style token, identifier, URL and backtick-quoted fragment through unchanged.',
            'Translate a given term the same way every time it appears.',
        ].join('\n');

        return [
            { role: 'system', content: system },
            { role: 'user', content },
        ];
    }

    private async post(body: Record<string, unknown>): Promise<Response> {
        const apiKey = this.config('apiKey', '');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
        }

        // Gateway-specific fields the caller needs us to pass through verbatim.
        const extra = this.config<Record<string, unknown>>('extraRequestParams', {});
        const timeoutSeconds = this.config('requestTimeout', 60);

        return fetch(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, ...extra }),
            // Without this a wedged gateway leaves the translation pending forever.
            signal: AbortSignal.timeout(timeoutSeconds * 1000),
        });
    }

    async _translate(content: string, { to = 'auto' }: ITranslateOptions): Promise<string> {
        const model = this.config('model', this.defaultModel);
        const messages = this.buildMessages(content, to);
        const temperature = this.config('temperature', 0);

        let response = await this.post({ model, messages, temperature, stream: false });

        // Some endpoints (notably reasoning models proxied through an
        // OpenAI-compatible gateway) reject any temperature but their own
        // default. Retry once with the smallest body that can still work.
        if (response.status === 400) {
            response = await this.post({ model, messages, stream: false });
        }

        if (!response.ok) {
            const detail = (await response.text()).slice(0, 200);
            throw new Error(`[${this.displayName}] ${response.status} ${response.statusText}: ${detail}`);
        }

        const payload = await response.json() as {
            choices?: { message?: { content?: string } }[];
        };
        const translated = payload.choices?.[0]?.message?.content;
        if (typeof translated !== 'string') {
            throw new Error(`[${this.displayName}] response contained no translation`);
        }

        return stripWrappingQuotes(translated.trim());
    }

    link(): string {
        return '';
    }
}

/**
 * Remove a pair of quotes the model wrapped the whole answer in.
 * Only strips when both ends match and the text is a single run, so a
 * translation that legitimately starts and ends with a quoted phrase survives.
 */
function stripWrappingQuotes(text: string): string {
    const pairs: [string, string][] = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』']];
    for (const [open, close] of pairs) {
        if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
            const inner = text.slice(open.length, -close.length);
            if (!inner.includes(open) && !inner.includes(close)) {
                return inner;
            }
        }
    }
    return text;
}

/** DeepSeek's hosted API. */
export class DeepSeekTranslate extends OpenAICompatibleTranslate {
    protected get configPrefix() { return 'deepseek'; }
    protected get defaultBaseUrl() { return 'https://api.deepseek.com/v1'; }
    protected get defaultModel() { return 'deepseek-chat'; }
    protected get displayName() { return 'DeepSeek'; }
}

/**
 * A local sub2api gateway, which exposes a subscription-backed model (Codex and
 * friends) as an OpenAI-compatible endpoint.
 */
export class Sub2ApiTranslate extends OpenAICompatibleTranslate {
    protected get configPrefix() { return 'sub2api'; }
    protected get defaultBaseUrl() { return 'http://127.0.0.1:8080/v1'; }
    protected get defaultModel() { return 'gpt-4o-mini'; }
    protected get displayName() { return 'sub2api'; }
}
