import {
    commands,
    EventEmitter,
    ExtensionContext,
    TextDocumentContentProvider,
    Uri,
    ViewColumn,
    window,
    workspace,
} from "vscode";
import { getConfig } from "../configuration";
import { buildFeatureLoadingSnapshot, translateFeatureDocumentProgressive } from "../syntax/featureDocument";
import { cachedTranslate, getUserLanguage } from "../translate/manager";

/** Custom URI scheme for translated `.feature` virtual documents */
export const TRANSLATED_FEATURE_SCHEME = "translated-feature";

/** Debounce delay (ms) before re-translating after a source document change */
const CHANGE_DEBOUNCE_MS = 500;

/** Whether a document is a Gherkin feature file. */
function isFeatureDocument(uri: Uri): boolean {
    return uri.path.toLowerCase().endsWith(".feature");
}

function getTargetLanguage(): string {
    return getConfig<string>("targetLanguage", getUserLanguage());
}

/**
 * Serves the translated `.feature` document as read-only virtual text.
 *
 * Unlike the markdown preview this is plain text opened in a normal editor —
 * there is no renderer for Gherkin — so no FileSystemProvider is needed: a
 * TextDocumentContentProvider is enough, and documents backed by one are
 * read-only by construction.
 *
 * Translation runs chunk by chunk in the background. Lines that have not come
 * back yet show the source text with a pending marker, and every finished chunk
 * fires a change event so the open editor updates in place.
 */
class TranslatedFeatureProvider implements TextDocumentContentProvider {
    private onDidChangeEmitter = new EventEmitter<Uri>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    /** Latest document snapshot per URI */
    private contentCache = new Map<string, string>();

    /** Active translation generation per URI, used to drop stale results */
    private activeTranslations = new Map<string, number>();

    /** Previous results per URI (sourceText → translatedText) for edit reuse */
    private previousResults = new Map<string, Map<string, string>>();

    /** Pending debounce timers per URI */
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Monotonic counter for translation generations */
    private generationCounter = 0;

    /** Ask VS Code to re-read the content for a URI. */
    fireChange(uri: Uri): void {
        this.onDidChangeEmitter.fire(uri);
    }

    async provideTextDocumentContent(uri: Uri): Promise<string> {
        const uriKey = uri.toString();

        const cached = this.contentCache.get(uriKey);
        if (cached !== undefined) {
            return cached;
        }

        const sourceUri = toSourceUri(uri);
        let sourceText: string;
        try {
            const sourceDocument = await workspace.openTextDocument(sourceUri);
            sourceText = sourceDocument.getText();
        } catch (error) {
            console.error('[CommentTranslate] Failed to open source feature file:', sourceUri.toString(), error);
            return `# Failed to open source: ${sourceUri.toString()}`;
        }

        if (!sourceText.trim()) {
            return sourceText;
        }

        // Show localised keywords plus the original prose straight away, so the
        // editor is never blank while the first chunk is in flight.
        const initialSnapshot = buildFeatureLoadingSnapshot(sourceText, getTargetLanguage());
        this.contentCache.set(uriKey, initialSnapshot);

        this.startTranslation(uri, sourceText);

        return initialSnapshot;
    }

    /**
     * Start a background translation, updating the cache and firing change
     * events as chunks complete. Reuses previous results for unchanged lines.
     */
    private startTranslation(uri: Uri, sourceText: string): void {
        const uriKey = uri.toString();
        const generationId = ++this.generationCounter;
        this.activeTranslations.set(uriKey, generationId);

        const isCurrent = () => this.activeTranslations.get(uriKey) === generationId;

        translateFeatureDocumentProgressive(
            sourceText,
            getTargetLanguage(),
            (text) => cachedTranslate(text),
            (snapshot) => {
                if (!isCurrent()) {
                    return;
                }
                this.contentCache.set(uriKey, snapshot);
                this.onDidChangeEmitter.fire(uri);
            },
            this.previousResults.get(uriKey),
        ).then(({ translated, resultsMap }) => {
            if (!isCurrent()) {
                return;
            }
            this.contentCache.set(uriKey, translated);
            this.previousResults.set(uriKey, resultsMap);
            this.activeTranslations.delete(uriKey);
            this.onDidChangeEmitter.fire(uri);
        }).catch((error) => {
            console.error('[CommentTranslate] Feature translation failed:', error);
            if (!isCurrent()) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.contentCache.set(uriKey, `# Translation error: ${message}\n${sourceText}`);
            this.activeTranslations.delete(uriKey);
            this.onDidChangeEmitter.fire(uri);
        });
    }

    /**
     * Schedule a debounced re-translation. The current snapshot stays visible
     * during the debounce window, and unchanged lines are reused from the
     * previous run, so editing the source does not blank the translated view.
     */
    scheduleRetranslation(uri: Uri): void {
        const uriKey = uri.toString();

        // Nothing is showing this document yet — nothing to refresh.
        if (!this.contentCache.has(uriKey)) {
            return;
        }

        const existingTimer = this.debounceTimers.get(uriKey);
        if (existingTimer !== undefined) {
            clearTimeout(existingTimer);
        }

        // Bump the generation so any in-flight translation stops publishing.
        this.activeTranslations.set(uriKey, ++this.generationCounter);

        const timer = setTimeout(async () => {
            this.debounceTimers.delete(uriKey);
            try {
                const sourceDocument = await workspace.openTextDocument(toSourceUri(uri));
                const sourceText = sourceDocument.getText();
                if (!sourceText.trim()) {
                    this.contentCache.set(uriKey, sourceText);
                    this.onDidChangeEmitter.fire(uri);
                    return;
                }
                this.startTranslation(uri, sourceText);
            } catch {
                // Source document may have been closed; ignore
            }
        }, CHANGE_DEBOUNCE_MS);

        this.debounceTimers.set(uriKey, timer);
    }

    /**
     * Drop all cached state for a URI so the next read re-translates from
     * scratch. Used when the target language or translation source changes.
     */
    invalidate(uri: Uri): void {
        const uriKey = uri.toString();
        this.contentCache.delete(uriKey);
        this.previousResults.delete(uriKey);
        this.activeTranslations.set(uriKey, ++this.generationCounter);
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
        this.contentCache.clear();
        this.activeTranslations.clear();
        this.previousResults.clear();
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
    }
}

/**
 * Convert a source `.feature` URI to its translated virtual document URI.
 *
 * The path mirrors the source path so the virtual document keeps the `.feature`
 * extension (and therefore Gherkin syntax highlighting); the original URI is
 * carried in the query.
 */
export function toTranslatedFeatureUri(sourceUri: Uri): Uri {
    return Uri.parse(
        `${TRANSLATED_FEATURE_SCHEME}://translated${sourceUri.path}?${encodeURIComponent(sourceUri.toString())}`
    );
}

/** Convert a translated virtual document URI back to its source URI. */
function toSourceUri(translatedUri: Uri): Uri {
    return Uri.parse(decodeURIComponent(translatedUri.query));
}

/**
 * Open the translated view for the active `.feature` file in a side column.
 */
async function openFeatureTranslateView(): Promise<void> {
    const activeEditor = window.activeTextEditor;
    if (!activeEditor) {
        window.showWarningMessage("No active feature file to translate.");
        return;
    }

    const sourceUri = activeEditor.document.uri;
    if (!isFeatureDocument(sourceUri)) {
        window.showWarningMessage("The active file is not a .feature document.");
        return;
    }

    const translatedUri = toTranslatedFeatureUri(sourceUri);
    const document = await workspace.openTextDocument(translatedUri);
    await window.showTextDocument(document, {
        viewColumn: ViewColumn.Beside,
        preview: false,
        preserveFocus: true,
    });
}

/**
 * Register the translated `.feature` view:
 * - TextDocumentContentProvider for the `translated-feature` scheme
 * - Command to open the translated view beside the source
 * - Debounced refresh when the source file or the translation config changes
 */
export function registerFeaturePreview(context: ExtensionContext): void {
    const provider = new TranslatedFeatureProvider();

    context.subscriptions.push(
        provider,
        workspace.registerTextDocumentContentProvider(TRANSLATED_FEATURE_SCHEME, provider),
        commands.registerCommand(
            "commentTranslate.openFeatureTranslateView",
            openFeatureTranslateView
        ),
    );

    context.subscriptions.push(
        workspace.onDidChangeTextDocument((event) => {
            if (event.document.uri.scheme === "file" && isFeatureDocument(event.document.uri)) {
                provider.scheduleRetranslation(toTranslatedFeatureUri(event.document.uri));
            }
        })
    );

    context.subscriptions.push(
        workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration("commentTranslate.targetLanguage") ||
                event.affectsConfiguration("commentTranslate.source")
            ) {
                for (const doc of workspace.textDocuments) {
                    if (doc.uri.scheme === TRANSLATED_FEATURE_SCHEME) {
                        provider.invalidate(doc.uri);
                        provider.fireChange(doc.uri);
                    }
                }
            }
        })
    );
}
