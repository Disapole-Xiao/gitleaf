import * as vscode from 'vscode';

interface IconDefinition {
    iconPath?: string;
    fontCharacter?: string;
    fontColor?: string;
    fontId?: string;
}

interface IconFont {
    id: string;
    src: Array<{ path: string; format: string }>;
    size?: string;
}

interface IconMappings {
    file?: string;
    fileNames?: Record<string, string>;
    fileExtensions?: Record<string, string>;
    languageIds?: Record<string, string>;
}

interface IconTheme extends IconMappings {
    iconDefinitions: Record<string, IconDefinition>;
    fonts?: IconFont[];
    light?: IconMappings;
    highContrast?: IconMappings;
}

export interface GraphFileIcons {
    css: string;
    file?: string;
    fileNames: Record<string, string>;
    fileExtensions: Record<string, string>;
    languageIds: Record<string, string>;
    languageNames: Record<string, string>;
    languageExtensions: Record<string, string>;
}

interface IconThemeContribution { id: string; path: string }
interface LanguageContribution { id: string; extensions?: string[]; filenames?: string[] }

/** The workbench does not expose resolved file icons to webviews. Read the
 * active public icon-theme contribution and let VS Code serve its assets. */
export async function graphFileIcons(webview: vscode.Webview): Promise<{ root: vscode.Uri; data: GraphFileIcons } | undefined> {
    const themeId = vscode.workspace.getConfiguration?.('workbench').get<string>('iconTheme');
    if (!themeId || !vscode.extensions?.all || !vscode.workspace.fs.readFile) return;
    const extensions = vscode.extensions.all;
    const owner = extensions.find(extension => (extension.packageJSON.contributes?.iconThemes as IconThemeContribution[] | undefined)
        ?.some(theme => theme.id === themeId));
    const contribution = (owner?.packageJSON.contributes?.iconThemes as IconThemeContribution[] | undefined)
        ?.find(theme => theme.id === themeId);
    if (!owner || !contribution) return;

    const themeUri = vscode.Uri.joinPath(owner.extensionUri, contribution.path);
    const theme = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(themeUri)).toString('utf8')) as IconTheme;
    const colorKind = vscode.window.activeColorTheme.kind;
    const variant = colorKind === vscode.ColorThemeKind.Light ? theme.light
        : colorKind === vscode.ColorThemeKind.HighContrast || colorKind === vscode.ColorThemeKind.HighContrastLight
            ? theme.highContrast : undefined;
    const definitions = Object.entries(theme.iconDefinitions || {});
    const classes = new Map(definitions.map(([name], index) => [name, `theme-icon-${index}`]));
    const map = (entries?: Record<string, string>): Record<string, string> => Object.fromEntries(
        Object.entries(entries || {}).flatMap(([key, value]) => classes.has(value) ? [[key.toLowerCase(), classes.get(value)!]] : []));
    const asset = (relative: string) => webview.asWebviewUri(vscode.Uri.joinPath(themeUri, '..', relative)).toString();
    const glyph = (value: string): string => {
        const codepoint = /^\\([0-9a-fA-F]{1,6})$/.exec(value)?.[1];
        return codepoint ? String.fromCodePoint(parseInt(codepoint, 16)) : value;
    };
    const css: string[] = [];
    for (const font of theme.fonts || []) {
        const sources = font.src.filter(source => /^[\w-]+$/.test(source.format))
            .map(source => `url(${JSON.stringify(asset(source.path))}) format(${JSON.stringify(source.format)})`);
        if (sources.length) css.push(`@font-face{font-family:${JSON.stringify(`gitleaf-icon-${font.id}`)};src:${sources.join(',')}}`);
    }
    for (const [name, definition] of definitions) {
        const className = classes.get(name)!;
        if (definition.iconPath) {
            css.push(`.${className}::before{content:"";display:block;width:16px;height:16px;background:center/contain no-repeat url(${JSON.stringify(asset(definition.iconPath))})}`);
        } else if (definition.fontCharacter) {
            const font = theme.fonts?.find(item => item.id === definition.fontId) || theme.fonts?.[0];
            if (!font) continue;
            const color = definition.fontColor && /^#[0-9a-fA-F]{3,8}$/.test(definition.fontColor) ? definition.fontColor : 'currentColor';
            const size = font.size && /^\d+(?:\.\d+)?(?:%|px|em)$/.test(font.size) ? font.size : '100%';
            css.push(`.${className}::before{content:${JSON.stringify(glyph(definition.fontCharacter))};font-family:${JSON.stringify(`gitleaf-icon-${font.id}`)};font-size:${size};color:${color};line-height:16px}`);
        }
    }

    const languageNames: Record<string, string> = {}, languageExtensions: Record<string, string> = {};
    for (const extension of extensions) {
        for (const language of (extension.packageJSON.contributes?.languages || []) as LanguageContribution[]) {
            for (const filename of language.filenames || []) languageNames[filename.toLowerCase()] = language.id;
            for (const suffix of language.extensions || []) languageExtensions[suffix.replace(/^\./, '').toLowerCase()] = language.id;
        }
    }
    const mappings = { ...theme, ...variant };
    return { root: owner.extensionUri, data: {
        css: css.join('\n'), file: classes.get(mappings.file || ''),
        fileNames: map({ ...theme.fileNames, ...variant?.fileNames }),
        fileExtensions: map({ ...theme.fileExtensions, ...variant?.fileExtensions }),
        languageIds: map({ ...theme.languageIds, ...variant?.languageIds }),
        languageNames, languageExtensions,
    } };
}
