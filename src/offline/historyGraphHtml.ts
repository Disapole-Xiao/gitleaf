/** Shared by the extension and the isolated visual smoke preview. No project
 * content is interpolated into HTML; it arrives through validated messages. */
export function historyGraphHtml(script: string, style: string, cspSource: string, nonce: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource}; font-src ${cspSource};">
<link rel="stylesheet" href="${style}"></head><body data-session="${nonce}">
<main id="graph" aria-label="GitLeaf version history"><div class="empty">Loading history…</div></main>
<aside id="hover" hidden></aside><div id="menu" role="menu" hidden></div>
<footer id="paging"></footer><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
