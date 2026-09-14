/**
 * GitLeaf Ignore Parser
 * Parses .gitleafignore files with support for $MAIN_TEX and $MAIN_PDF variables
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { IGNORE_FILE, DEFAULT_IGNORE_PATTERNS } from '../consts';
import { ignoreMatcher, resolveIgnoreRules } from './ignoreRules';
import { ProjectSettings } from '../core/projectStore';

/**
 * Ignore Parser - handles .gitleafignore patterns
 */
export class IgnoreParser {
    private patterns: string[] = [];
    private resolvedPatterns: string[] = [];
    private matches = ignoreMatcher([]);

    constructor(
        private readonly root: string,
        private settings?: ProjectSettings
    ) {}

    /**
     * Get the path to .gitleafignore file
     */
    private getIgnoreFilePath(): string {
        return path.join(this.root, IGNORE_FILE);
    }

    /**
     * Load patterns from .gitleafignore file
     */
    async load(): Promise<void> {
        try {
            const ignoreFilePath = this.getIgnoreFilePath();
            const content = await fs.readFile(ignoreFilePath);
            const text = new TextDecoder().decode(content);
            this.patterns = this.parseIgnoreFile(text);
        } catch {
            // File doesn't exist, use defaults
            this.patterns = [...DEFAULT_IGNORE_PATTERNS];
        }
        this.resolveVariables();
    }

    /**
     * Parse .gitleafignore file content
     */
    private parseIgnoreFile(content: string): string[] {
        return content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments
    }

    /**
     * Resolve variables like $MAIN_TEX and $MAIN_PDF
     */
    private resolveVariables(): void {
        this.resolvedPatterns = resolveIgnoreRules(this.patterns.join('\n'), this.settings);
        this.matches = ignoreMatcher(this.resolvedPatterns);
    }

    /**
     * Update settings (e.g., when mainTex/mainPdf changes)
     */
    updateSettings(settings: ProjectSettings): void {
        this.settings = settings;
        this.resolveVariables();
    }

    /**
     * Check if a path should be ignored
     */
    shouldIgnore(relativePath: string): boolean {
        return this.matches(relativePath);
    }

    /**
     * Get all patterns (raw, unresolved)
     */
    getPatterns(): string[] {
        return [...this.patterns];
    }

    /**
     * Get resolved patterns
     */
    getResolvedPatterns(): string[] {
        return [...this.resolvedPatterns];
    }

    /**
     * Save patterns to .gitleafignore file
     */
    async save(patterns: string[]): Promise<void> {
        this.patterns = patterns;
        this.resolveVariables();

        const content = patterns.join('\n') + '\n';
        await fs.writeFile(
            this.getIgnoreFilePath(),
            new TextEncoder().encode(content)
        );
    }

    /**
     * Create a default .gitleafignore file
     */
    async createDefault(): Promise<void> {
        const defaultContent = `# GitLeaf Ignore File
# Patterns work like .gitignore
# Use $MAIN_PDF to reference the main PDF file from settings

# Don't sync the compiled PDF (prevents corruption during local compile)
$MAIN_PDF

# Hidden files and directories
.*
.*/**

# LaTeX build artifacts
build/
*.aux
*.bbl
*.bcf
*.blg
*.fdb_latexmk
*.fls
*.log
*.out
*.run.xml
*.synctex.gz
*.synctex(busy)
*.toc
*.lof
*.lot
*.xdv

# GitLeaf config directory
.gitleaf/**
`;
        await fs.writeFile(
            this.getIgnoreFilePath(),
            new TextEncoder().encode(defaultContent)
        );
        await this.load();
    }

    /**
     * Check if .gitleafignore file exists
     */
    async exists(): Promise<boolean> {
        try {
            await fs.stat(this.getIgnoreFilePath());
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Add a pattern to the ignore file
     */
    async addPattern(pattern: string): Promise<void> {
        if (!this.patterns.includes(pattern)) {
            this.patterns.push(pattern);
            await this.save(this.patterns);
        }
    }

    /**
     * Remove a pattern from the ignore file
     */
    async removePattern(pattern: string): Promise<void> {
        const index = this.patterns.indexOf(pattern);
        if (index !== -1) {
            this.patterns.splice(index, 1);
            await this.save(this.patterns);
        }
    }
}
