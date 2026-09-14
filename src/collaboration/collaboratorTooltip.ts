import * as vscode from 'vscode';
import { COMMANDS } from '../consts';
import type { TrackedUser } from './cursorTracker';

type TooltipUser = Pick<TrackedUser, 'clientId' | 'name'>;

/** Unchanged rosters must produce no status-bar API calls, including show(). */
export function renderCollaboratorStatus(
    item: vscode.StatusBarItem,
    users: ReadonlyArray<TooltipUser> | undefined,
    previous: string,
): string {
    if (!users) {
        if (previous) item.hide();
        return '';
    }
    const signature = JSON.stringify(users.map(user => [user.clientId, user.name]).sort());
    if (signature === previous) return previous;
    // The built-in action shows the hover belonging to the clicked/focused
    // status item. It does not query cursors, select a user, or open a menu.
    if (!previous) item.command = 'workbench.action.showHover';
    item.text = `$(organization) ${users.length}`;
    item.tooltip = createCollaboratorTooltip(users);
    // VS Code's show() always sends an update, even for an already visible
    // item. Calling it every second rebuilds the hover and makes it flicker.
    item.show();
    return signature;
}

/** Show clickable names only; locations are resolved from the live cache on click. */
export function createCollaboratorTooltip(
    users: ReadonlyArray<TooltipUser>
): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    // Collaborator names are remote input. Escape labels and permit only our
    // cursor-jump command, never arbitrary commands embedded in a user's name.
    tooltip.isTrusted = { enabledCommands: [COMMANDS.JUMP_TO_COLLABORATOR] };
    tooltip.supportHtml = true;
    if (!users.length) return tooltip.appendText('No collaborators online.');

    tooltip.appendText(`${users.length} collaborator${users.length === 1 ? '' : 's'} online`);
    // A raw HTML block preserves title="". Markdown links replace an empty
    // title with the command URI in VS Code 1.108, exposing a long tooltip.
    // Keeping labels inside this block also prevents Markdown in remote names
    // from being interpreted as nested links or images.
    tooltip.appendMarkdown('\n\n<ul>\n');
    for (const user of users) {
        const label = (user.name.replace(/[\r\n]+/g, ' ') || 'Unnamed collaborator')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Resolve by connection ID, not name or cached coordinates. This also
        // distinguishes collaborators with identical names or multiple sessions.
        const args = encodeURIComponent(JSON.stringify([user.clientId]));
        tooltip.appendMarkdown(`<li><a href="command:${COMMANDS.JUMP_TO_COLLABORATOR}?${args}" title="" draggable="false">${label}</a></li>\n`);
    }
    tooltip.appendMarkdown('</ul>');
    return tooltip;
}
