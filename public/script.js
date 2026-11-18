'use strict';

// WuTong Mountain - everything the page does in the browser.
//
// The browser owns the whole journey. `game` is the single source of truth:
//   { id, startTime, opening: story, turns: [{ choice, choiceIndex, story, at }] }
// where a story is { narrative, choices, metadata: { location, dreamState, atmosphere } }.
// Everything on screen (story, journal, counters, exports) is drawn from `game`.
// The server keeps nothing, so saving and loading never need the network.

// ===== SETTINGS =====

// Where saves live in the browser's localStorage.
const STORE = {
    autosave: 'wutong.v2.autosave',
    savePrefix: 'wutong.v2.save.',      // one entry per manual save
    migrated: 'wutong.v2.migrated',
    unreadable: 'wutong.v2.unreadable',
    // Old format. Read once for conversion, then left untouched as a backup.
    legacyAutosave: 'wutongMountainAutosave',
    legacySaves: 'wutongMountainSaves'
};

const APP_ID = 'wutong-mountain';
const SAVE_VERSION = 2;
const MAX_SAVE_NAME_LENGTH = 80;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MIST_PARTICLES = 30;
const TOAST_MS = 3000;

const STORAGE_PROBLEM = 'Your browser would not store the save. Its storage may be full, or blocked (for example in private browsing). You can still keep this journey with Load → Download.';

// ===== STATE =====

let game = null;              // the journey on screen, or null on the opening screen
let busy = false;             // true while waiting for the server
let gameEpoch = 0;            // changes whenever a different journey is put on screen
let unsavedProgress = false;  // progress exists that is only in the autosave
let clockTimer = null;
let toastTimer = null;

const elements = {
    startButton: document.getElementById('start-button'),
    restartButton: document.getElementById('restart-button'),
    saveButton: document.getElementById('save-button'),
    loadButton: document.getElementById('load-button'),
    exportButton: document.getElementById('export-button'),
    journalToggle: document.getElementById('journal-toggle'),
    loading: document.getElementById('loading'),
    narrativeText: document.getElementById('narrative-text'),
    locationInfo: document.getElementById('location-info'),
    choicesContainer: document.getElementById('choices-container'),
    choicesGrid: document.querySelector('.choices-grid'),
    dreamJournal: document.getElementById('dream-journal'),
    journalPath: document.getElementById('journal-path'),
    stepCount: document.getElementById('step-count'),
    dreamCount: document.getElementById('dream-count'),
    timeElapsed: document.getElementById('time-elapsed'),
    closeJournal: document.getElementById('close-journal'),
    heroSection: document.getElementById('hero-section'),
    mistParticles: document.getElementById('mist-particles')
};

// ===== SMALL HELPERS =====

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(className, label, onClick) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function formatDate(iso) {
    const date = new Date(iso);
    return isNaN(date) ? 'Unknown date' : date.toLocaleString();
}

// "12m", "3h 5m", "2d 4h"
function formatDuration(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function todayString() {
    return new Date().toISOString().slice(0, 10);
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, char => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
}

function downloadFile(content, filename, mimeType) {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = el('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

// ===== READING A JOURNEY =====
// The one place that answers questions about a journey, for the screen,
// the journal, the load menu and the exports alike.

function isDreaming(story) {
    return story.metadata.dreamState === 'dreaming';
}

function stateIcon(story) {
    return isDreaming(story) ? '💭' : '👁️';
}

function latestStory(journey) {
    const turns = journey.turns;
    return turns.length ? turns[turns.length - 1].story : journey.opening;
}

function countDreams(journey) {
    return journey.turns.filter(turn => isDreaming(turn.story)).length;
}

// The journey as a list of passages: the opening, then one per step.
function passages(journey) {
    return [
        { title: 'The Beginning', choice: null, story: journey.opening },
        ...journey.turns.map((turn, i) => ({ title: `Step ${i + 1}`, choice: turn.choice, story: turn.story }))
    ];
}

// ===== VALIDATION =====
// Anything read from storage, a file, or the server passes through these
// before it is used, so a damaged save can never half-load.

function cleanStory(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.narrative !== 'string' || !raw.narrative.trim()) return null;

    const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
    const text = (value, fallback) =>
        typeof value === 'string' && value.trim() ? value.trim() : fallback;

    return {
        narrative: raw.narrative,
        choices: Array.isArray(raw.choices)
            ? raw.choices.filter(c => typeof c === 'string' && c.trim())
            : [],
        metadata: {
            location: text(meta.location, 'Unknown'),
            dreamState: meta.dreamState === 'dreaming' ? 'dreaming' : 'waking',
            atmosphere: text(meta.atmosphere, 'uncertain')
        }
    };
}

// Returns a clean copy of a journey, or null if it cannot be played.
function cleanGame(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.turns)) return null;

    const opening = cleanStory(raw.opening);
    if (!opening) return null;

    const turns = [];
    for (const turn of raw.turns) {
        const story = cleanStory(turn && turn.story);
        if (!story || typeof turn.choice !== 'string' || !turn.choice.trim()) return null;
        turns.push({
            choice: turn.choice,
            choiceIndex: Number.isInteger(turn.choiceIndex) ? turn.choiceIndex : null,
            story,
            at: typeof turn.at === 'string' ? turn.at : null
        });
    }

    const journey = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
        startTime: Number.isFinite(raw.startTime) ? raw.startTime : Date.now(),
        opening,
        turns
    };

    // The story currently on screen must offer choices, or play cannot go on.
    return latestStory(journey).choices.length ? journey : null;
}

// ===== STORAGE =====
// Every localStorage call goes through these so that a full or blocked
// storage (private browsing, quota) is reported instead of crashing.

function storeGet(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.error('Could not read from storage:', key, error);
        return null;
    }
}

function storeSet(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        console.error('Could not write to storage:', key, error);
        return false;
    }
}

function storeRemove(key) {
    try {
        localStorage.removeItem(key);
    } catch (error) {
        console.error('Could not remove from storage:', key, error);
    }
}

function storeKeys(prefix) {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(prefix)) keys.push(key);
        }
        return keys;
    } catch (error) {
        console.error('Could not list storage:', error);
        return [];
    }
}

// ===== OVERLAYS, DIALOGS AND MESSAGES =====
// Drawn on the page rather than using the browser's alert/confirm/prompt
// pop-ups, which some phone browsers block.

// A dimmed full-screen layer holding one panel. `onDismiss` runs when the
// player presses Escape or taps outside the panel.
function openOverlay({ id, className, title, onDismiss }) {
    const overlay = el('div', className ? `overlay ${className}` : 'overlay');
    if (id) overlay.id = id;
    overlay.dismiss = onDismiss;
    overlay.addEventListener('click', event => {
        if (event.target === overlay) onDismiss();
    });

    const panel = el('div', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', title);
    panel.appendChild(el('h2', '', title));

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return { overlay, panel };
}

function topOverlay() {
    const open = document.querySelectorAll('.overlay');
    return open.length ? open[open.length - 1] : null;
}

// Shows a dialog and resolves with { button, value } once it is answered.
// `button` is the chosen button's value, or null if the dialog was dismissed.
// `value` is the text typed, when the dialog has an input.
function showDialog({ title, message, body, input, buttons }) {
    return new Promise(resolve => {
        let inputEl = null;

        const finish = value => {
            overlay.remove();
            resolve({ button: value, value: inputEl ? inputEl.value : undefined });
        };

        const { overlay, panel } = openOverlay({
            className: 'dialog-overlay',
            title,
            onDismiss: () => finish(null)
        });
        panel.classList.add('dialog-content');

        if (message) panel.appendChild(el('p', 'dialog-message', message));
        if (body) panel.appendChild(body);

        if (input) {
            inputEl = el('input', 'dialog-input');
            inputEl.type = 'text';
            inputEl.maxLength = MAX_SAVE_NAME_LENGTH;
            inputEl.value = input.value || '';
            inputEl.setAttribute('aria-label', message || title);
            inputEl.addEventListener('keydown', event => {
                if (event.key === 'Enter') finish(buttons[0].value);
            });
            panel.appendChild(inputEl);
        }

        const row = el('div', 'dialog-buttons');
        const buttonEls = buttons.map(spec =>
            button(spec.primary ? 'menu-btn dialog-primary' : 'menu-btn', spec.label, () => finish(spec.value)));
        row.append(...buttonEls);
        panel.appendChild(row);

        if (inputEl) {
            inputEl.focus();
            inputEl.select();
        } else {
            buttonEls[0].focus();
        }
    });
}

function showMessage(title, message) {
    return showDialog({ title, message, buttons: [{ label: 'OK', value: true }] });
}

async function confirmDialog(title, message, okLabel) {
    const result = await showDialog({
        title,
        message,
        buttons: [
            { label: okLabel, value: true, primary: true },
            { label: 'Cancel', value: false }
        ]
    });
    return result.button === true;
}

// A brief note at the bottom of the screen that fades by itself.
function toast(message) {
    let node = document.getElementById('toast');
    if (!node) {
        node = el('div', 'toast');
        node.id = 'toast';
        node.setAttribute('role', 'status');
        document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), TOAST_MS);
}

// ===== PUTTING A JOURNEY ON SCREEN =====

function setBusy(value) {
    busy = value;
    elements.saveButton.disabled = value;
    elements.loadButton.disabled = value;
    elements.startButton.disabled = value;
    const continueBtn = document.getElementById('load-autosave-button');
    if (continueBtn) continueBtn.disabled = value;
}

function showLoading() {
    elements.loading.classList.remove('hidden');
    elements.choicesContainer.classList.add('hidden');
}

function hideLoading() {
    elements.loading.classList.add('hidden');
}

// Redraw everything from `game`.
function renderGame() {
    const story = latestStory(game);

    hideLoading();
    displayStory(story);
    applyAtmosphere(story);
    renderJournal();
    startClock();

    elements.heroSection.classList.add('hidden');
    document.getElementById('load-autosave-button')?.remove();
    elements.startButton.classList.add('hidden');
    elements.restartButton.classList.remove('hidden');
    elements.saveButton.classList.remove('hidden');
    elements.exportButton.classList.remove('hidden');
    elements.journalToggle.classList.remove('hidden');
}

// Replace whatever is on screen with a different journey.
function applyGame(newGame) {
    gameEpoch++;
    game = newGame;
    renderGame();
}

function displayStory(story) {
    elements.locationInfo.textContent = '';
    elements.locationInfo.append(
        `${stateIcon(story)} `, el('strong', '', 'Location:'), ` ${story.metadata.location} | `,
        el('strong', '', 'State:'), ` ${story.metadata.dreamState} | `,
        el('strong', '', 'Atmosphere:'), ` ${story.metadata.atmosphere}`
    );

    elements.narrativeText.textContent = story.narrative;
    displayChoices(story.choices);
}

function displayChoices(choices) {
    elements.choicesGrid.textContent = '';

    choices.forEach((choice, index) => {
        const choiceBtn = button('choice-btn', undefined, () => makeChoice(choice, index));
        choiceBtn.append(el('span', 'choice-number', String(index + 1)), ` ${choice}`);
        elements.choicesGrid.appendChild(choiceBtn);
    });

    elements.choicesContainer.classList.remove('hidden');
}

// The page background follows the story: waking, dreaming, or nightmare.
function applyAtmosphere(story) {
    const dreaming = isDreaming(story);
    const dark = /dark|nightmare/i.test(story.metadata.atmosphere);
    document.body.classList.toggle('dreaming', dreaming && !dark);
    document.body.classList.toggle('nightmare', dreaming && dark);
}

// ===== PLAYING =====

async function startGame() {
    if (busy) return;

    const existing = readAutosave();
    if (existing) {
        const ok = await confirmDialog(
            'Begin a new journey?',
            `Your autosaved journey (${describeSave(existing)}) will be replaced. Manual saves are not affected.`,
            'Begin anew'
        );
        if (!ok) return;
    }

    const epoch = gameEpoch;
    setBusy(true);
    showLoading();

    try {
        const story = await requestStory('/api/start');
        if (epoch !== gameEpoch) return; // a different journey was loaded meanwhile

        applyGame({ id: newId(), startTime: Date.now(), opening: story, turns: [] });
        unsavedProgress = false;
        autosave();
    } catch (error) {
        console.error('Error starting game:', error);
        hideLoading();
        showMessage('The journey could not begin', error.userMessage || 'Please check your connection and try again.');
    } finally {
        setBusy(false);
    }
}

async function makeChoice(choice, index) {
    if (busy || !game) return;

    const epoch = gameEpoch;
    setBusy(true);
    showLoading();
    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
        const story = await requestStory('/api/continue', {
            opening: game.opening,
            turns: game.turns.map(turn => ({
                choice: turn.choice,
                choiceIndex: turn.choiceIndex,
                story: turn.story
            })),
            choice,
            choiceIndex: index
        });
        if (epoch !== gameEpoch) return; // a different journey was loaded meanwhile

        // Only reached when the server answered with a usable story, so a
        // failed choice never adds a step.
        game.turns.push({ choice, choiceIndex: index, story, at: new Date().toISOString() });
        unsavedProgress = true;
        renderGame();
        autosave();
    } catch (error) {
        console.error('Error continuing story:', error);
        hideLoading();
        // Bring the current choices back so the player can try again.
        if (epoch === gameEpoch) elements.choicesContainer.classList.remove('hidden');
        showMessage('The mist obscures the path', error.userMessage || 'Please check your connection and try again.');
    } finally {
        setBusy(false);
    }
}

// Ask the server for a story. Throws (with a message that is safe to show
// the player in error.userMessage) if the server reported an error or sent
// back something that isn't a usable story.
async function requestStory(url, payload) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined
    });

    let data = null;
    try {
        data = await response.json();
    } catch (e) {
        // Not JSON (e.g. an HTML error page from the host)
    }

    if (!response.ok) {
        const error = new Error(`Server returned ${response.status}`);
        error.userMessage = data?.error || `The server returned an error (${response.status}).`;
        throw error;
    }

    const story = cleanStory(data?.story);
    if (!story || story.choices.length === 0) {
        const error = new Error('Server response did not contain a valid story');
        error.userMessage = 'The server sent back an incomplete story.';
        throw error;
    }

    return story;
}

async function restartGame() {
    if (busy) return;
    const ok = await confirmDialog(
        'Return to the mountain?',
        'This begins anew. Your current journey will be lost unless you have saved it.',
        'Return'
    );
    if (!ok) return;
    storeRemove(STORE.autosave);
    location.reload();
}

// Keyboard: Escape closes whatever is open; number keys pick a choice.
function handleKeydown(event) {
    if (event.key === 'Escape') {
        const overlay = topOverlay();
        if (overlay) {
            overlay.dismiss();
        } else if (!elements.dreamJournal.classList.contains('hidden')) {
            toggleJournal();
        }
        return;
    }

    if (!game || busy || topOverlay()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;

    const number = Number(event.key);
    const choiceBtn = Number.isInteger(number) && number >= 1
        ? elements.choicesGrid.children[number - 1]
        : null;
    if (choiceBtn && !elements.choicesContainer.classList.contains('hidden')) choiceBtn.click();
}

// ===== JOURNAL =====

function renderJournal() {
    elements.stepCount.textContent = game.turns.length;
    elements.dreamCount.textContent = countDreams(game);
    elements.journalPath.textContent = '';

    passages(game).forEach(passage => {
        const entry = button('journal-entry', undefined, () => showPassage(passage));
        entry.title = 'Read this passage again';

        const header = el('span', 'journal-entry-header');
        header.append(
            el('span', 'journal-step', `${stateIcon(passage.story)} ${passage.title}`),
            el('span', 'journal-location', passage.story.metadata.location)
        );
        entry.appendChild(header);
        if (passage.choice) entry.appendChild(el('span', 'journal-choice', `"${passage.choice}"`));

        elements.journalPath.appendChild(entry);
    });

    // Keep the latest entry in view.
    const scroller = elements.journalPath.parentNode;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

// Re-read an earlier part of the journey.
function showPassage(passage) {
    const body = el('div', 'passage');
    if (passage.choice) body.appendChild(el('p', 'passage-choice', `"${passage.choice}"`));
    body.appendChild(el('p', 'passage-text', passage.story.narrative));

    showDialog({
        title: `${passage.title} · ${passage.story.metadata.location}`,
        body,
        buttons: [{ label: 'Close', value: true }]
    });
}

function toggleJournal() {
    const nowHidden = elements.dreamJournal.classList.toggle('hidden');
    elements.journalToggle.textContent = nowHidden ? '📔 Journal' : '📔 Close Journal';
    elements.journalToggle.setAttribute('aria-expanded', String(!nowHidden));
}

// The "Begun" figure in the journal: how long ago this journey started.
function startClock() {
    const update = () => {
        elements.timeElapsed.textContent = `${formatDuration(Date.now() - game.startTime)} ago`;
    };
    clearInterval(clockTimer);
    update();
    clockTimer = setInterval(update, 30000);
}

// ===== EXPORTING THE JOURNEY AS A DOCUMENT =====

const EXPORT_FORMATS = [
    { icon: '📝', name: 'Markdown', description: '.md - For note apps', run: () => exportAsFile(buildMarkdown(), 'md', 'text/markdown', 'Markdown') },
    { icon: '📄', name: 'PDF', description: '.pdf - Formatted document', run: exportAsPdf },
    { icon: '📋', name: 'Plain Text', description: '.txt - Simple text file', run: () => exportAsFile(buildPlainText(), 'txt', 'text/plain', 'Text') },
    { icon: '🌐', name: 'HTML', description: '.html - Web page', run: () => exportAsFile(buildHtml(), 'html', 'text/html', 'HTML') }
];

function showExportMenu() {
    if (!game) return;
    closeExportMenu();

    const { panel } = openOverlay({ id: 'export-menu', title: 'Export Journey', onDismiss: closeExportMenu });
    panel.appendChild(el('p', 'dialog-message', 'Choose your preferred format:'));

    const grid = el('div', 'export-format-grid');
    EXPORT_FORMATS.forEach(format => {
        const formatBtn = button('export-format-btn', undefined, () => {
            closeExportMenu();
            format.run();
        });
        formatBtn.append(
            el('span', 'format-icon', format.icon),
            el('span', 'format-name', format.name),
            el('span', 'format-desc', format.description)
        );
        grid.appendChild(formatBtn);
    });

    panel.append(grid, button('menu-btn', 'Cancel', closeExportMenu));
}

function closeExportMenu() {
    document.getElementById('export-menu')?.remove();
}

function exportAsFile(content, extension, mimeType, label) {
    downloadFile(content, `wutong-journey-${todayString()}.${extension}`, mimeType);
    toast(`Journey exported as ${label}`);
}

function exportAsPdf() {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        showMessage('Pop-up blocked', 'Your browser blocked the print window. Allow pop-ups for this site, or export as HTML and print that file.');
        return;
    }
    printWindow.document.write(buildHtml());
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 500);
    toast('Opening print dialog - choose "Save as PDF"');
}

// The facts shown at the top of every export.
function exportStats() {
    return [
        ['Steps Taken', game.turns.length],
        ['Dreams Entered', countDreams(game)],
        ['Started', new Date(game.startTime).toLocaleString()],
        ['Exported', new Date().toLocaleString()]
    ];
}

function buildMarkdown() {
    const parts = [
        '# WuTong Mountain Journey',
        "## 梧桐山 - The Dream Doctor's Path",
        '**Journey Statistics:**\n' + exportStats().map(([label, value]) => `- ${label}: ${value}`).join('\n'),
        '---'
    ];

    passages(game).forEach(({ title, choice, story }) => {
        parts.push(`## ${title}: ${story.metadata.location}`);
        parts.push(`**State:** ${stateIcon(story)} ${isDreaming(story) ? 'Dreaming' : 'Waking'}`);
        if (choice) parts.push(`**Choice Made:**\n> ${choice}`);
        parts.push(story.narrative, '---');
    });

    parts.push('*Generated from WuTong Mountain*\n*A journey without destination | 無為*');
    return parts.join('\n\n') + '\n';
}

function buildPlainText() {
    const parts = [
        "WuTong Mountain Journey\n梧桐山 - The Dream Doctor's Path",
        'Journey Statistics:\n' + exportStats().map(([label, value]) => `- ${label}: ${value}`).join('\n'),
        '='.repeat(60)
    ];

    passages(game).forEach(({ title, choice, story }) => {
        parts.push(`${title}: ${story.metadata.location}\nState: ${isDreaming(story) ? 'Dreaming' : 'Waking'}`);
        if (choice) parts.push(`Choice Made:\n  "${choice}"`);
        parts.push(story.narrative, '-'.repeat(60));
    });

    parts.push('Generated from WuTong Mountain\nA journey without destination | 無為');
    return parts.join('\n\n') + '\n';
}

const EXPORT_HTML_STYLE = `
        body { font-family: Georgia, 'Times New Roman', serif; max-width: 800px; margin: 0 auto; padding: 2rem;
               background: linear-gradient(to bottom, #0a0e27 0%, #1a1a2e 50%, #16213e 100%); color: #e8e8e8; line-height: 1.8; }
        h1 { color: #ffd700; text-align: center; font-weight: 300; letter-spacing: 0.2rem; margin-bottom: 0.5rem; }
        h2 { color: #ffd700; font-weight: 300; letter-spacing: 0.15rem; text-align: center; font-size: 1.2rem;
             margin-bottom: 2rem; font-style: italic; }
        .stats { background: rgba(255, 215, 0, 0.1); border-left: 3px solid rgba(255, 215, 0, 0.5); padding: 1rem; margin: 2rem 0; }
        .stats strong { color: #ffd700; }
        .entry { background: rgba(255, 255, 255, 0.03); padding: 1.5rem; margin: 2rem 0; border-radius: 4px;
                 border-left: 3px solid rgba(255, 215, 0, 0.3); }
        .entry-header { color: #ffd700; font-size: 1.2rem; margin-bottom: 1rem; display: flex;
                        justify-content: space-between; align-items: center; gap: 1rem; }
        .state { font-size: 0.9rem; color: #888; }
        .choice { background: rgba(255, 215, 0, 0.05); padding: 1rem; margin: 1rem 0;
                  border-left: 2px solid rgba(255, 215, 0, 0.3); font-style: italic; }
        .narrative { margin-top: 1rem; white-space: pre-line; }
        .footer { text-align: center; margin-top: 3rem; padding-top: 2rem; border-top: 1px solid rgba(255, 215, 0, 0.2);
                  color: #888; font-style: italic; }
        @media print {
            body { background: white; color: black; }
            h1, h2, .entry-header, strong { color: #000; }
            .stats { background: #f5f5f5; border-left-color: #333; }
            .entry { background: #fafafa; border-left-color: #666; break-inside: avoid; }
        }`;

// The story text comes from outside this page (the server, or an imported
// save file), so every piece is escaped before it goes into the document.
function buildHtml() {
    const stats = exportStats()
        .map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`)
        .join('<br>\n        ');

    const entries = passages(game).map(({ title, choice, story }) => `
    <div class="entry">
        <div class="entry-header">
            <span>${stateIcon(story)} ${escapeHtml(title)}: ${escapeHtml(story.metadata.location)}</span>
            <span class="state">${isDreaming(story) ? 'Dreaming' : 'Waking'}</span>
        </div>${choice ? `
        <div class="choice"><strong>Choice Made:</strong><br>"${escapeHtml(choice)}"</div>` : ''}
        <div class="narrative">${escapeHtml(story.narrative)}</div>
    </div>`).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WuTong Mountain Journey</title>
    <style>${EXPORT_HTML_STYLE}
    </style>
</head>
<body>
    <h1>WuTong Mountain Journey</h1>
    <h2>梧桐山 | The Dream Doctor's Path</h2>

    <div class="stats">
        <strong>Journey Statistics:</strong><br>
        ${stats}
    </div>
${entries}

    <div class="footer">
        Generated from WuTong Mountain<br>
        A journey without destination | 無為
    </div>
</body>
</html>`;
}

// ===== SAVING AND LOADING =====
//
// A save is { app, version, id, name, savedAt, game }. The autosave and the
// manual saves use this same shape, as do downloaded save files. Saving and
// loading only read and write the browser's storage - no server involved.

function makeSaveRecord(id, name, journey, savedAt) {
    return {
        app: APP_ID,
        version: SAVE_VERSION,
        id,
        name,
        savedAt: savedAt || new Date().toISOString(),
        game: journey
    };
}

// Returns a usable save record, or null if the stored data is damaged.
function cleanSaveRecord(raw) {
    const journey = cleanGame(raw && raw.game);
    if (!journey) return null;
    return makeSaveRecord(
        typeof raw.id === 'string' && raw.id ? raw.id : newId(),
        typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_SAVE_NAME_LENGTH) : 'Unnamed journey',
        journey,
        typeof raw.savedAt === 'string' ? raw.savedAt : null
    );
}

function readAutosave() {
    return cleanSaveRecord(storeGet(STORE.autosave));
}

// Manual saves, newest first. Each carries the storage key it lives under.
function listManualSaves() {
    return storeKeys(STORE.savePrefix)
        .map(key => {
            const record = cleanSaveRecord(storeGet(key));
            return record ? { ...record, key } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

function describeSave(record) {
    return `${latestStory(record.game).metadata.location}, ${plural(record.game.turns.length, 'step')}`;
}

// Runs after every successful choice.
function autosave() {
    if (!game) return;
    if (storeSet(STORE.autosave, makeSaveRecord('autosave', 'Autosave', game))) {
        toast('💾 Autosaved');
    } else {
        toast('⚠ Autosave failed - browser storage is full or blocked');
    }
}

async function saveGame() {
    if (busy || !game) return;

    const defaultName = `Journey ${new Date().toLocaleString()}`;
    const result = await showDialog({
        title: 'Save Journey',
        message: 'Name this point in your journey:',
        input: { value: defaultName },
        buttons: [
            { label: 'Save', value: true, primary: true },
            { label: 'Cancel', value: false }
        ]
    });
    if (result.button !== true) return;

    const name = (result.value || '').trim().slice(0, MAX_SAVE_NAME_LENGTH) || defaultName;
    const record = makeSaveRecord(newId(), name, game);

    if (!storeSet(STORE.savePrefix + record.id, record)) {
        showMessage('Save failed', STORAGE_PROBLEM);
        return;
    }

    unsavedProgress = false;
    toast(`Journey saved: ${name}`);
}

// The "Continue Journey" button on the opening screen.
function showContinueButton() {
    document.getElementById('load-autosave-button')?.remove();
    if (game || !readAutosave()) return;

    const continueBtn = button('control-btn autosave-btn', '🔄 Continue Journey', () => {
        const record = readAutosave();
        if (record) loadSave(record, true);
    });
    continueBtn.id = 'load-autosave-button';
    // Placed above "Begin the Descent": continuing is what a returning player usually wants.
    elements.startButton.parentNode.insertBefore(continueBtn, elements.startButton);
}

// Put a saved journey on screen. Nothing here can fail halfway: the save was
// already checked by cleanSaveRecord, and no network is involved.
async function loadSave(record, isAutosave) {
    if (busy) return;

    if (game && unsavedProgress && !(isAutosave && record.game.id === game.id)) {
        const ok = await confirmDialog(
            'Leave this journey?',
            'Your current journey has progress that is not in a manual save. Loading will replace it.',
            'Load anyway'
        );
        if (!ok) return;
    }

    closeLoadMenu();
    applyGame(record.game);
    // An autosave with steps in it exists nowhere else, so it still counts as unsaved.
    unsavedProgress = isAutosave && record.game.turns.length > 0;
    autosave();
    toast(isAutosave ? 'Journey continued from autosave' : `Journey loaded: ${record.name}`);
}

async function deleteSave(record) {
    const ok = await confirmDialog('Delete saved journey?', `"${record.name}" will be permanently deleted.`, 'Delete');
    if (!ok) return;

    storeRemove(record.key);
    showLoadMenu();
    toast(`Journey deleted: ${record.name}`);
}

// ----- Save files (backup, and moving a journey between devices) -----

function downloadSave(record) {
    const { key, ...fileRecord } = record;
    const slug = record.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'journey';
    downloadFile(JSON.stringify(fileRecord, null, 2), `wutong-save-${slug}-${todayString()}.json`, 'application/json');
    toast(`Save file downloaded: ${record.name}`);
}

function importSaveFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
        showMessage('File not loaded', 'That file is too large to be a WuTong Mountain save.');
        return;
    }

    const reader = new FileReader();
    reader.onerror = () => showMessage('File not loaded', 'The file could not be read.');
    reader.onload = () => {
        let parsed = null;
        try {
            parsed = JSON.parse(reader.result);
        } catch (e) {
            // handled below
        }

        // Accept a full save file, or just the journey inside one.
        const record = cleanSaveRecord(parsed && parsed.game ? parsed : { game: parsed });
        if (!record) {
            showMessage('File not loaded', 'That file is not a WuTong Mountain save, or it is damaged.');
            return;
        }

        if (!parsed.name) record.name = 'Imported journey';
        record.id = newId();
        if (!storeSet(STORE.savePrefix + record.id, record)) {
            showMessage('File not loaded', STORAGE_PROBLEM);
            return;
        }

        showLoadMenu();
        toast(`Save file added: ${record.name}`);
    };
    reader.readAsText(file);
}

// ----- Load menu -----

function showLoadMenu() {
    closeLoadMenu();

    const { panel } = openOverlay({ id: 'load-menu', title: 'Saved Journeys', onDismiss: closeLoadMenu });

    const list = el('div', 'save-list');
    const autosaveRecord = readAutosave();
    const saves = listManualSaves();

    if (autosaveRecord) list.appendChild(buildSaveItem(autosaveRecord, true));
    saves.forEach(record => list.appendChild(buildSaveItem(record, false)));

    if (!autosaveRecord && saves.length === 0) {
        list.appendChild(el('p', 'dialog-message', 'No saved journeys yet.'));
    }

    // Old-format saves that could not be converted (originals are kept).
    (storeGet(STORE.unreadable) || []).forEach(name => {
        const item = el('div', 'save-item save-item-unreadable');
        const info = el('div', 'save-info');
        info.append(
            el('strong', '', String(name)),
            el('small', '', 'Older save that could not be converted. The original is still stored in this browser.')
        );
        item.appendChild(info);
        list.appendChild(item);
    });

    // Load from a downloaded save file
    const fileInput = el('input', 'hidden');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.addEventListener('change', () => importSaveFile(fileInput.files[0]));

    const footer = el('div', 'dialog-buttons');
    footer.append(
        button('menu-btn', '📂 Load from file', () => fileInput.click()),
        button('menu-btn', 'Close', closeLoadMenu)
    );

    panel.append(
        list,
        fileInput,
        footer,
        el('p', 'save-hint', 'Saves are kept in this browser only, and browsers can clear them. Use Download to keep a backup file or move a journey to another device.')
    );
}

function buildSaveItem(record, isAutosave) {
    const journey = record.game;
    const item = el('div', isAutosave ? 'save-item autosave-item' : 'save-item');

    const info = el('div', 'save-info');
    info.append(
        el('strong', '', isAutosave ? '🔄 Autosave (Latest)' : record.name),
        el('small', '', formatDate(record.savedAt)),
        el('small', '', `Location: ${latestStory(journey).metadata.location}`),
        el('small', '', `Steps: ${journey.turns.length} | Dreams: ${countDreams(journey)}`)
    );

    const actions = el('div', 'save-actions');
    actions.append(
        button('load-btn', 'Load', () => loadSave(record, isAutosave)),
        button('load-btn', 'Download', () => downloadSave(record))
    );
    if (!isAutosave) actions.appendChild(button('delete-btn', 'Delete', () => deleteSave(record)));

    item.append(info, actions);
    return item;
}

function closeLoadMenu() {
    document.getElementById('load-menu')?.remove();
}

// ===== CONVERTING OLD SAVES =====
//
// Before the save system was rebuilt, saves held the raw conversation with
// the server in one of several shapes. This runs once, converts each old save
// to the current format, and leaves the originals in place as a backup.

function migrateLegacySaves() {
    if (storeGet(STORE.migrated)) return;

    const unreadable = [];
    let storageFailed = false;

    const convert = (name, legacy, key) => {
        const journey = convertLegacySave(legacy);
        if (!journey) {
            unreadable.push(name);
            return;
        }
        const savedAt = typeof legacy.savedAt === 'string' ? legacy.savedAt : null;
        if (!storeSet(key, makeSaveRecord(key, name, journey, savedAt))) storageFailed = true;
    };

    try {
        const legacyAutosave = storeGet(STORE.legacyAutosave);
        if (legacyAutosave && !storeGet(STORE.autosave)) {
            convert('Autosave', legacyAutosave, STORE.autosave);
        }

        const legacySaves = storeGet(STORE.legacySaves) || {};
        Object.keys(legacySaves).forEach((name, i) => {
            // A fixed key per old save, so a repeated run cannot create duplicates.
            convert(name, legacySaves[name] || {}, `${STORE.savePrefix}legacy-${i}`);
        });
    } catch (error) {
        console.error('Converting old saves failed:', error);
        return; // try again on the next visit
    }

    if (storageFailed) {
        console.error('Not enough browser storage to convert all old saves; will retry on next visit.');
        return;
    }

    storeSet(STORE.unreadable, unreadable);
    storeSet(STORE.migrated, { at: new Date().toISOString() });
}

// Pull a JSON object out of text that may have code fences or prose around it.
function parseLooseJson(text) {
    if (typeof text !== 'string') return null;
    const candidates = [text.trim()];

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) candidates.push(fenced[1].trim());

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (e) {
            // try the next candidate
        }
    }
    return null;
}

// Returns a journey in the current format, or null if the old save does not
// hold enough to continue from.
function convertLegacySave(legacy) {
    if (!legacy || typeof legacy !== 'object') return null;

    // Old saves nested the session data one or two levels deep.
    let session = legacy.sessionData;
    if (session && session.sessionData) session = session.sessionData;
    session = session && typeof session === 'object' ? session : {};

    const history = Array.isArray(session.history) ? session.history.filter(m => m && typeof m === 'object') : [];
    const journal = Array.isArray(legacy.journalEntries) ? legacy.journalEntries.filter(e => e && typeof e === 'object') : [];
    const onScreen = cleanStory(session.currentState) || cleanStory(session.story);

    // The server's replies hold each story; the player's messages hold each choice.
    const replies = history.filter(m => m.role === 'assistant').map(m => cleanStory(parseLooseJson(m.content)));
    const choices = history.filter(m => m.role === 'user').slice(1).map(m => {
        const match = typeof m.content === 'string' && m.content.match(/^The player chose: "([\s\S]*)" \(option (\d+)\)\./);
        return match ? { choice: match[1], choiceIndex: Number(match[2]) - 1 } : null;
    });

    const turnCount = replies.length > 0 ? replies.length - 1 : journal.length;

    // Where a reply is missing or unreadable, fall back to what the journal recorded.
    const fromJournal = entry => entry && cleanStory({
        narrative: entry.narrative,
        choices: [],
        metadata: { location: entry.location, dreamState: entry.dreamState }
    });

    const stories = [];
    for (let i = 0; i <= turnCount; i++) {
        let story = replies[i] || null;
        if (i === turnCount && onScreen && onScreen.choices.length) story = onScreen;
        if (!story && i > 0) story = fromJournal(journal[i - 1]);
        if (!story && i === 0 && turnCount > 0) {
            story = cleanStory({ narrative: '(The beginning of this journey was not recorded.)', choices: [] });
        }
        if (!story) return null;
        stories.push(story);
    }

    const turns = [];
    for (let i = 1; i <= turnCount; i++) {
        const recorded = choices[i - 1];
        const entry = journal[i - 1] || {};
        const choice = (recorded && recorded.choice) || (typeof entry.choice === 'string' ? entry.choice : '');
        if (!choice.trim()) return null;
        turns.push({
            choice,
            choiceIndex: recorded ? recorded.choiceIndex : null,
            story: stories[i],
            at: typeof entry.timestamp === 'string' ? entry.timestamp : null
        });
    }

    return cleanGame({ startTime: legacy.startTime, opening: stories[0], turns });
}

// ===== VISUAL EFFECTS =====

// Slow drifting mist behind the page. Skipped for visitors whose device
// asks for reduced motion.
function createMistParticles() {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    for (let i = 0; i < MIST_PARTICLES; i++) {
        const particle = el('div', 'mist-particle');
        const size = Math.random() * 60 + 20;

        particle.style.left = `${Math.random() * 100}%`;
        particle.style.top = `${Math.random() * 100}%`;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        particle.style.animationDuration = `${Math.random() * 20 + 30}s`;
        particle.style.animationDelay = `${Math.random() * 10}s`;

        elements.mistParticles.appendChild(particle);
    }
}

// ===== START-UP =====

elements.startButton.addEventListener('click', startGame);
elements.restartButton.addEventListener('click', restartGame);
elements.saveButton.addEventListener('click', saveGame);
elements.loadButton.addEventListener('click', showLoadMenu);
elements.exportButton.addEventListener('click', showExportMenu);
elements.journalToggle.addEventListener('click', toggleJournal);
elements.closeJournal.addEventListener('click', toggleJournal);
document.addEventListener('keydown', handleKeydown);

createMistParticles();
migrateLegacySaves();
showContinueButton();
