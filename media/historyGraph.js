/* Presentation only. Never interpolate server text as HTML or run arbitrary
 * commands. The extension resolves every record ID and file index itself. */
(() => {
    const vscode = acquireVsCodeApi();
    const session = document.body.dataset.session;
    const graph = document.getElementById('graph'), paging = document.getElementById('paging');
    const hover = document.getElementById('hover'), menu = document.getElementById('menu');
    const files = new Map(), pending = new Set(), expanded = new Set();
    const state = vscode.getState();
    let records = [], comparison, selected = state?.session === session ? state.selected : undefined;
    let mode = state?.mode === 'list' ? 'list' : 'tree', iconTheme, iconThemeReady = false, hoverTimer, hideTimer, hoverOwner;
    const iconStyle = document.createElement('style'); iconStyle.setAttribute('nonce', session); document.head.append(iconStyle);
    document.body.dataset.mode = mode;
    function el(tag, className, text) {
        const node = document.createElement(tag); node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function post(type, id, index) { vscode.postMessage({ type, id, index, session }); }
    function hideHover() { clearTimeout(hoverTimer); clearTimeout(hideTimer); hover.hidden = true; hoverOwner = undefined; }
    function scheduleHideHover() { clearTimeout(hoverTimer); clearTimeout(hideTimer); hideTimer = setTimeout(hideHover, 180); }
    function position(popup, rect) {
        popup.hidden = false;
        popup.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - popup.offsetWidth - 4))}px`;
        const below = rect.bottom + 4;
        popup.style.top = `${Math.max(4, below + popup.offsetHeight <= innerHeight ? below : rect.top - popup.offsetHeight - 4)}px`;
    }
    function showHover(row, button) {
        if (!menu.hidden || !button.isConnected) return;
        hover.replaceChildren(); hoverOwner = button;
        const heading = el('div', 'hover-heading');
        heading.append(el('span', 'avatar', (row.author || '?').slice(0, 1).toUpperCase()), el('strong', '', row.author || 'Unknown author'));
        hover.append(heading, el('div', 'hover-date', new Date(row.date).toLocaleString()),
            el('div', 'hover-message', row.hoverMessage));
        const children = files.get(row.id);
        if (children) {
            const counts = el('div', 'hover-stats', `${children.length} file${children.length === 1 ? '' : 's'} changed`);
            for (const status of ['A', 'M', 'D', 'R']) {
                const count = children.filter(file => file.status.startsWith(status)).length;
                if (count) counts.append(el('span', `status-${status}`, `${count} ${status}`));
            }
            hover.append(counts);
        }
        const labels = el('div', 'hover-labels');
        if (row.version !== undefined) labels.append(el('span', 'version', `v${row.version}`));
        for (const label of row.labels) labels.append(el('span', 'tag', `◇ ${label}`));
        if (labels.childElementCount) hover.append(labels);
        const footer = el('div', 'hover-footer');
        footer.append(el('span', '', row.hash || 'Overleaf'), el('span', '', row.pending ? 'Push confirmation pending' : row.kind === 'local' ? 'Not pushed' : 'Published'));
        hover.append(footer);
        position(hover, button.getBoundingClientRect());
    }
    function showMenu(row, event, button) {
        event.preventDefault(); hideHover(); menu.replaceChildren();
        const actions = [];
        if (comparison && comparison.id !== row.id) actions.push(['compare', 'Compare with Selected']);
        actions.push(['selectCompare', 'Select for Compare']);
        actions.push(['label', 'Label…']);
        if (row.kind === 'remote') actions.push(['restore', 'Restore and Sync…']);
        else if (!row.pending) actions.push(['soft', 'Revert · Soft…'], ['hard', 'Revert · Hard…']);
        for (const [type, text] of actions) {
            const item = el('button', 'menu-item', text); item.setAttribute('role', 'menuitem');
            if (type === 'compare') item.title = `Compare with ${comparison.label} (left side)`;
            item.addEventListener('click', () => { menu.hidden = true; button.focus(); post(type, row.id); });
            menu.append(item);
        }
        position(menu, event.type === 'contextmenu' && event.clientX ? { left: event.clientX, top: event.clientY, bottom: event.clientY } : button.getBoundingClientRect());
        menu.querySelector('button')?.focus();
    }
    function requestFiles(id) {
        if (pending.has(id)) return;
        pending.add(id); post('files', id);
    }
    function toggle(id, open = !expanded.has(id)) {
        hideHover(); selected = id; vscode.setState({ selected, session, mode });
        if (open) { expanded.add(id); if (!files.has(id)) requestFiles(id); }
        else expanded.delete(id);
        render();
    }
    function fileTree(row, children) {
        function iconClass(filePath) {
            if (!iconTheme) return;
            const filename = filePath.split('/').at(-1).toLowerCase();
            let icon = iconTheme.fileNames[filename], language = iconTheme.languageNames[filename];
            for (let dot = filename.indexOf('.'); dot >= 0; dot = filename.indexOf('.', dot + 1)) {
                const suffix = filename.slice(dot + 1);
                icon ||= iconTheme.fileExtensions[suffix];
                language ||= iconTheme.languageExtensions[suffix];
            }
            return icon || iconTheme.languageIds[language] || iconTheme.file;
        }
        function fileButton(file, index, name) {
            const button = el('button', 'file'); button.dataset.key = `${row.id}:${index}`;
            button.title = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
            const themeClass = iconClass(file.path);
            if (themeClass || !iconThemeReady) button.append(el('span', `file-icon${themeClass ? ` ${themeClass}` : ''}`,
                themeClass ? undefined : '▤'));
            button.append(el('span', 'filename', name), el('span', `badge status-${file.status[0]}`, file.status[0]));
            button.addEventListener('click', () => post('open', row.id, index));
            return button;
        }
        if (mode === 'list') {
            const container = el('div', 'file-list');
            children.map((file, index) => ({ file, index })).sort((a, b) => a.file.path.localeCompare(b.file.path))
                .forEach(({ file, index }) => container.append(fileButton(file, index, file.path)));
            return container;
        }
        const root = { folders: new Map(), files: [] };
        children.forEach((file, index) => {
            const parts = file.path.split('/'); let cursor = root;
            for (const part of parts.slice(0, -1)) {
                if (!cursor.folders.has(part)) cursor.folders.set(part, { folders: new Map(), files: [] });
                cursor = cursor.folders.get(part);
            }
            cursor.files.push({ file, index, name: parts.at(-1) });
        });
        function branch(node) {
            const container = el('div', 'tree');
            for (const [name, folder] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
                const details = el('details', 'folder'); details.open = true;
                const title = el('summary', 'folder-name', name);
                details.append(title, branch(folder)); container.append(details);
            }
            for (const { file, index, name } of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
                container.append(fileButton(file, index, name));
            }
            return container;
        }
        return branch(root);
    }
    function rail(row, previous) {
        const surface = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        surface.setAttribute('class', `rail lane-${row.lane} kind-${row.kind}${row.synced ? ' synced' : ' unsynced'}`);
        surface.setAttribute('viewBox', '0 0 44 25');
        surface.setAttribute('aria-hidden', 'true');
        const path = (shape, className) => {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            line.setAttribute('d', shape); line.setAttribute('class', className);
            surface.append(line);
        };
        const color = kind => kind === 'local' ? 'track-local' : 'track-remote';
        // The 4px node (plus stroke) has a small gap on both sides of the
        // line; its 1.2x hover circle almost closes each gap.
        const incoming = (x, kind) => path(`M${x} 0 V5.2`, color(kind));
        const outgoing = (x, kind) => path(`M${x} 18.8 V25`, color(kind));
        if (row.lane === 'local') {
            if (previous?.lane === 'local') incoming(30, 'local');
            outgoing(30, 'local');
        } else if (row.lane === 'remote') {
            path('M30 0 V25', 'track-local');
            if (previous?.lane === 'remote') incoming(14, 'remote');
            outgoing(14, 'remote');
        } else if (row.lane === 'join') {
            path('M30 0 Q30 12 20.7 12', 'track-local');
            incoming(14, 'remote');
            outgoing(14, 'remote');
        } else {
            if (previous) incoming(14, previous.kind);
            outgoing(14, row.kind);
        }
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', row.lane === 'local' ? '30' : '14');
        dot.setAttribute('cy', '12'); dot.setAttribute('r', '4');
        dot.setAttribute('class', 'rail-node');
        surface.append(dot);
        return surface;
    }
    function pointerIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'pointer-icon'); svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        if (type === 'LOCAL') {
            for (const radius of [5.5, 2.2]) {
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('cx', '8'); circle.setAttribute('cy', '8'); circle.setAttribute('r', String(radius));
                svg.append(circle);
            }
        } else {
            const cloud = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            cloud.setAttribute('d', 'M4.4 12.6h7.1a2.7 2.7 0 0 0 .2-5.4 3.8 3.8 0 0 0-7.3-1.1 3.3 3.3 0 0 0 0 6.5Z');
            svg.append(cloud);
        }
        return svg;
    }
    function pointer(type, folded) {
        const badge = el('span', `pointer pointer-${type.toLowerCase()}${folded ? ' icon-only' : ''}`);
        badge.append(pointerIcon(type));
        if (folded) { badge.setAttribute('aria-label', 'remote'); badge.title = 'remote'; }
        else badge.append(el('span', '', type.toLowerCase()));
        return badge;
    }
    function changesIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('class', 'changes-icon');
        const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        outline.setAttribute('d', 'M3 2.5h9l4 4v11H3z M12 2.5v4h4 M6 11h7 M9.5 7.5v7');
        svg.append(outline);
        return svg;
    }
    function setMode(value) {
        if (value !== 'tree' && value !== 'list') return;
        mode = value; document.body.dataset.mode = value;
        vscode.setState({ selected, session, mode });
        render();
    }
    function render() {
        clearTimeout(hoverTimer);
        const focused = document.activeElement?.dataset.key, scroll = document.scrollingElement.scrollTop;
        // Keep an already open hover frozen; never rebuild it on incoming data.
        graph.replaceChildren();
        for (const [index, row] of records.entries()) {
            const section = el('section', `record lane-${row.lane} kind-${row.kind}${expanded.has(row.id) ? ' expanded' : ''}`);
            const button = el('button', `commit lane-${row.lane}${selected === row.id ? ' selected' : ''}`);
            button.dataset.key = row.id; button.setAttribute('aria-expanded', String(expanded.has(row.id)));
            button.append(rail(row, records[index - 1]));
            const content = el('span', 'commit-content');
            if (row.label) {
                content.append(el('span', 'subject', row.label));
                if (row.author) content.append(el('span', 'author', row.author));
                if (row.version !== undefined) content.append(el('span', 'version', `v${row.version}`));
            } else {
                if (row.version !== undefined) content.append(el('span', 'version', `v${row.version}`));
                if (row.author) content.append(el('span', 'author', row.author));
            }
            if (row.pending) content.append(el('span', 'pending', '◷'));
            button.append(content);
            if (row.pointers.length) {
                const badges = el('span', 'commit-pointers');
                const folded = row.pointers.includes('LOCAL') && row.pointers.includes('REMOTE');
                for (const type of row.pointers) badges.append(pointer(type, folded && type === 'REMOTE'));
                button.append(badges);
            }
            button.addEventListener('click', () => toggle(row.id));
            button.addEventListener('mouseenter', () => {
                clearTimeout(hoverTimer); clearTimeout(hideTimer);
                if (hoverOwner !== button) hoverTimer = setTimeout(() => showHover(row, button), 450);
            });
            button.addEventListener('mouseleave', scheduleHideHover);
            button.addEventListener('contextmenu', event => showMenu(row, event, button));
            button.addEventListener('keydown', event => {
                if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); toggle(row.id, event.key === 'ArrowRight'); }
                if (event.key === 'F10' && event.shiftKey) showMenu(row, event, button);
            });
            const openChanges = el('button', 'open-changes');
            openChanges.type = 'button'; openChanges.title = 'Open Changes';
            openChanges.setAttribute('aria-label', 'Open Changes');
            openChanges.append(changesIcon());
            openChanges.addEventListener('click', () => { hideHover(); post('openAll', row.id); });
            section.append(button, openChanges);
            if (expanded.has(row.id)) {
                const children = files.get(row.id);
                if (children?.length) section.append(fileTree(row, children));
                else section.append(el('div', 'empty', children ? 'No changed files' : 'Loading changed files…'));
            }
            graph.append(section);
        }
        if (!records.length) graph.append(el('div', 'empty', 'No history available.'));
        if (focused) [...graph.querySelectorAll('button')].find(button => button.dataset.key === focused)?.focus({ preventScroll: true });
        document.scrollingElement.scrollTop = scroll;
    }
    hover.addEventListener('mouseenter', () => { clearTimeout(hoverTimer); clearTimeout(hideTimer); });
    hover.addEventListener('mouseleave', scheduleHideHover);
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) menu.hidden = true; });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') { menu.hidden = true; hideHover(); }
        const surface = menu.hidden ? graph : menu;
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...surface.querySelectorAll('button, summary')].filter(button => button.getClientRects().length);
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
        if (buttons[next]) { event.preventDefault(); buttons[next].focus(); }
    });
    window.addEventListener('scroll', () => { if (hoverOwner) hideHover(); menu.hidden = true; });
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.session !== session) return;
        if (message.type === 'records') {
            records = message.rows;
            comparison = message.comparison;
            if (message.mode === 'list' || message.mode === 'tree') {
                mode = message.mode; document.body.dataset.mode = mode;
                vscode.setState({ selected, session, mode });
            }
            const ids = new Set(records.map(row => row.id));
            for (const id of expanded) if (!ids.has(id)) expanded.delete(id);
            // Only an explicit Show Commit selects/expands a new record. No
            // restore-all-expanded fetch burst when VS Code recreates the view.
            if (message.selected && ids.has(message.selected)) { selected = message.selected; expanded.add(selected); if (!files.has(selected)) requestFiles(selected); }
            paging.replaceChildren();
            for (const source of message.more) {
                const more = el('button', 'more', `Load older ${source === 'remote' ? 'versions' : 'commits'}…`);
                more.dataset.source = source;
                more.addEventListener('click', () => { more.disabled = true; vscode.postMessage({ type: 'more', source, session }); }); paging.append(more);
            }
            render();
        } else if (message.type === 'comparison') {
            comparison = message.comparison; render();
        } else if (message.type === 'mode') {
            setMode(message.mode);
        } else if (message.type === 'iconTheme') {
            iconTheme = message.icons; iconThemeReady = true;
            iconStyle.textContent = iconTheme?.css || '';
            render();
        } else if (message.type === 'files') {
            pending.delete(message.id); files.set(message.id, message.files); render();
        } else if (message.type === 'requestFailed') {
            // The extension shows a native notification. Clear only the failed
            // read's loading state; the next explicit click can retry it.
            if (message.action === 'files') {
                pending.delete(message.id);
                if (!files.has(message.id)) expanded.delete(message.id);
                render();
            } else if (message.action === 'more') {
                for (const button of paging.querySelectorAll('button')) {
                    if (button.dataset.source === message.source) button.disabled = false;
                }
            }
        }
    });
    post('ready');
})();
