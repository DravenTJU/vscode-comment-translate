const config: Record<string, unknown> = {};

jest.mock("../../../src/configuration", () => ({
    getConfig: (key: string, defaultValue: unknown) =>
        config[key] === undefined || config[key] === "" ? defaultValue : config[key],
}));

import { DeepSeekTranslate, Sub2ApiTranslate } from "../../../src/translate/OpenAICompatibleTranslate";

type Call = { url: string; headers: Record<string, string>; body: any };

let calls: Call[] = [];
let responses: { status: number; payload?: unknown; text?: string }[] = [];

function mockFetch() {
    return jest.fn(async (url: string, init: any) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        const next = responses.shift() ?? { status: 200, payload: { choices: [{ message: { content: "译文" } }] } };
        return {
            ok: next.status >= 200 && next.status < 300,
            status: next.status,
            statusText: String(next.status),
            json: async () => next.payload,
            text: async () => next.text ?? "",
        };
    });
}

beforeEach(() => {
    calls = [];
    responses = [];
    for (const key of Object.keys(config)) {
        delete config[key];
    }
    (globalThis as any).fetch = mockFetch();
});

describe("OpenAI-compatible translate source", () => {
    it("posts to the configured endpoint with a bearer token", async () => {
        config["deepseek.apiKey"] = "sk-test";
        const result = await new DeepSeekTranslate().translate("hello", { to: "zh-CN" });

        expect(result).toBe("译文");
        expect(calls[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
        expect(calls[0].headers.Authorization).toBe("Bearer sk-test");
    });

    it("omits the Authorization header when no key is configured", async () => {
        await new Sub2ApiTranslate().translate("hello", { to: "zh-CN" });
        expect(calls[0].headers.Authorization).toBeUndefined();
    });

    it("uses each source's own settings and defaults", async () => {
        config["sub2api.apiBaseUrl"] = "http://localhost:9000/v1/";
        config["sub2api.model"] = "codex-mini";
        await new Sub2ApiTranslate().translate("hello", { to: "zh-CN" });

        // Trailing slash trimmed, /v1 kept as given by the user.
        expect(calls[0].url).toBe("http://localhost:9000/v1/chat/completions");
        expect(calls[0].body.model).toBe("codex-mini");
    });

    it("never sends max_tokens or the repetition penalties", async () => {
        await new DeepSeekTranslate().translate("hello", { to: "zh-CN" });
        expect(calls[0].body).not.toHaveProperty("max_tokens");
        expect(calls[0].body).not.toHaveProperty("frequency_penalty");
        expect(calls[0].body).not.toHaveProperty("presence_penalty");
        expect(calls[0].body.temperature).toBe(0);
    });

    it("asks for a line-preserving, terminology-stable translation", async () => {
        await new DeepSeekTranslate().translate("a\nb", { to: "zh-CN" });
        const system = calls[0].body.messages[0].content;
        expect(calls[0].body.messages[0].role).toBe("system");
        expect(system).toContain("zh-CN");
        expect(system).toContain("exactly the same number of lines");
        expect(system).toContain("⟦0⟧");
        expect(system).toContain("the same way every time");
        // The text itself goes through untouched — no wrapping quotes.
        expect(calls[0].body.messages[1].content).toBe("a\nb");
    });

    it("merges extraRequestParams into the body", async () => {
        config["sub2api.extraRequestParams"] = { reasoning_effort: "low", stream: true };
        await new Sub2ApiTranslate().translate("hello", { to: "zh-CN" });
        expect(calls[0].body.reasoning_effort).toBe("low");
        // Extra params win, so a gateway that demands a value can have it.
        expect(calls[0].body.stream).toBe(true);
    });

    it("aborts a request that outlives the configured timeout", async () => {
        config["sub2api.requestTimeout"] = 0.01;
        (globalThis as any).fetch = jest.fn((_url: string, init: any) =>
            new Promise((_resolve, reject) => {
                init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
            }));
        await expect(new Sub2ApiTranslate().translate("hello", { to: "zh-CN" }))
            .rejects.toThrow(/abort/i);
    });

    it("retries once without temperature when the endpoint rejects it", async () => {
        responses = [
            { status: 400, text: "temperature is not supported" },
            { status: 200, payload: { choices: [{ message: { content: "译文" } }] } },
        ];
        const result = await new Sub2ApiTranslate().translate("hello", { to: "zh-CN" });

        expect(result).toBe("译文");
        expect(calls).toHaveLength(2);
        expect(calls[0].body).toHaveProperty("temperature");
        expect(calls[1].body).not.toHaveProperty("temperature");
    });

    it("reports the endpoint's error instead of returning empty text", async () => {
        responses = [
            { status: 401, text: "invalid api key" },
            { status: 401, text: "invalid api key" },
        ];
        await expect(new DeepSeekTranslate().translate("hello", { to: "zh-CN" }))
            .rejects.toThrow(/DeepSeek.*401.*invalid api key/);
    });

    it("strips quotes the model wrapped the whole answer in", async () => {
        responses = [{ status: 200, payload: { choices: [{ message: { content: '"提交成功"' } }] } }];
        await expect(new DeepSeekTranslate().translate("x", { to: "zh-CN" })).resolves.toBe("提交成功");
    });

    it("keeps quotes that are part of the translation", async () => {
        responses = [{ status: 200, payload: { choices: [{ message: { content: '我应该看到 "Submission successful"' } }] } }];
        await expect(new DeepSeekTranslate().translate("x", { to: "zh-CN" }))
            .resolves.toBe('我应该看到 "Submission successful"');
    });

    it("keeps a multi-line reply intact", async () => {
        responses = [{ status: 200, payload: { choices: [{ message: { content: "第一行\n第二行" } }] } }];
        await expect(new DeepSeekTranslate().translate("a\nb", { to: "zh-CN" })).resolves.toBe("第一行\n第二行");
    });
});
