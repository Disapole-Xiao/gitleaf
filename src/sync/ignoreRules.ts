import ignore from 'ignore';
import { DEFAULT_IGNORE_PATTERNS } from '../consts';

export interface MainFiles { mainTex?: string; mainPdf?: string }
export function resolveIgnoreRules(content?: string, settings: MainFiles = {}): string[] {
    const patterns = content === undefined ? DEFAULT_IGNORE_PATTERNS : content.split(/\r?\n/);
    return patterns.map(pattern => pattern
        .replace(/\$MAIN_TEX/g, settings.mainTex || 'main.tex')
        .replace(/\$MAIN_PDF/g, settings.mainPdf || 'main.pdf'));
}
export function ignoreMatcher(patterns: string[]): (path: string) => boolean {
    const matcher = ignore().add(patterns);
    return value => {
        const relative = value.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!relative || /^(\.git|\.gitleaf)(\/|$)/.test(relative) || relative === '.gitleafignore') return true;
        return matcher.ignores(relative);
    };
}
