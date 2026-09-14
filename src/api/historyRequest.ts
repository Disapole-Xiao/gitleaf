/** HTTP failures from the history API are distinct from login failures. */
export class HistoryRequestError extends Error {
    constructor(readonly status: number, readonly retryAt?: number) {
        super(status === 429
            ? `Overleaf history is rate limited (429). Retry after ${new Date(retryAt!).toLocaleTimeString()}.`
            : status === 401 || status === 302
                ? 'Your Overleaf session has expired. Log in again to view history.'
                : status === 403
                    ? 'Overleaf denied access to this project history (403). Check your account and history access.'
                    : `Overleaf history request failed (${status}). Please try again later.`);
    }
}

export function historyRetryAt(header: string | null, now = Date.now()): number {
    const seconds = header?.trim() ? Number(header) : NaN;
    const deadline = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(header || '');
    // Respect both HTTP-date and delta-seconds. Missing/invalid headers get a
    // conservative cooldown, never a tight retry loop against Overleaf.
    return Number.isFinite(deadline) ? Math.max(now + 1000, deadline) : now + 60000;
}

/** Only fixed categories and allowlisted HTTP metadata leave the response.
 * Never log an error body: login pages can embed CSRF tokens and user data.
 * A 429 alone cannot distinguish application throttling from an edge block.
 */
export function historyResponseDiagnostic(headers: { get(name: string): string | null }, body: string): string {
    const type = (headers.get('content-type') || '').split(';')[0].toLowerCase();
    const format = type.includes('json') ? 'json' : type.includes('html') ? 'html' : type.startsWith('text/') ? 'text' : 'other';
    const edge = headers.get('server')?.toLowerCase().includes('cloudflare') ? 'cloudflare' : 'other';
    const reason = headers.get('cf-mitigated') === 'challenge' || /cf-chl-|challenge-platform|just a moment\.\.\./i.test(body)
        ? 'challenge' : /too many requests|rate.?limit/i.test(body) ? 'rate-limit-message'
            : /access denied|request blocked|forbidden/i.test(body) ? 'access-block-message' : body.length ? 'unclassified' : 'empty';
    const retry = headers.get('retry-after');
    const retryDescription = !retry ? 'absent' : /^\d+$/.test(retry) ? `${Number(retry)}s` : Number.isFinite(Date.parse(retry)) ? 'http-date' : 'invalid';
    return `format=${format}; edge=${edge}; reason=${reason}; retry-after=${retryDescription}`;
}

/** Shared by an account's projects, not by a disposable graph/controller.
 * Only explicit user actions request data. A 429 never starts an auto-retry.
 */
export class HistoryRequests {
    private tail: Promise<unknown> = Promise.resolve();
    private readonly pending = new Map<string, Promise<unknown>>();
    private readonly cache = new Map<string, { value: unknown; expires: number }>();
    private nextRequestAt = 0;
    private retryAt = 0;

    constructor(
        private readonly now = () => Date.now(),
        private readonly wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)),
    ) {}

    invalidate(key: string): void { this.cache.delete(key); }

    run<T>(key: string, lifetime: number, request: () => Promise<T>): Promise<T> {
        const cached = this.cache.get(key);
        if (cached && cached.expires > this.now()) return Promise.resolve(cached.value as T);
        if (this.pending.has(key)) return this.pending.get(key) as Promise<T>;
        const operation = this.tail.then(async () => {
            if (this.retryAt > this.now()) throw new HistoryRequestError(429, this.retryAt);
            if (this.nextRequestAt > this.now()) await this.wait(this.nextRequestAt - this.now());
            {
                this.nextRequestAt = this.now() + 2500;
                try {
                    const result = await request();
                    if (lifetime > 0) {
                        this.cache.set(key, { value: result, expires: this.now() + lifetime });
                        if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
                    }
                    return result;
                } catch (error) {
                    if (!(error instanceof HistoryRequestError) || error.status !== 429) throw error;
                    this.retryAt = error.retryAt!;
                    throw error;
                }
            }
        });
        this.pending.set(key, operation);
        this.tail = operation.catch(() => undefined);
        void operation.finally(() => this.pending.delete(key)).catch(() => undefined);
        return operation;
    }
}

const accountQueues = new Map<string, HistoryRequests>();
export function historyRequestsFor(server: string, userId: string): HistoryRequests {
    const key = JSON.stringify([new URL(server).origin, userId]);
    let queue = accountQueues.get(key);
    if (!queue) { queue = new HistoryRequests(); accountQueues.set(key, queue); }
    return queue;
}
