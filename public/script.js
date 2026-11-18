// ===== GAME STATE =====
//
// The browser owns the whole journey. `game` is the single source of truth:
//   { id, startTime, opening: story, turns: [{ choice, choiceIndex, story, at }] }
// where a story is { narrative, choices, metadata }. The server keeps nothing,
// so saving and loading never need the network.
//
// The variables below `game` are derived from it by syncDerived() and exist
// only so the journal and export code can read them. Never set them directly.
let game = null;
let currentStory = null;
let journalEntries = [];
let stepCount = 0;
let dreamCount = 0;
let startTime = null;

let timeInterval = null;
let busy = false;             // true while waiting for the server
let gameEpoch = 0;            // changes whenever a different journey is put on screen
let unsavedProgress = false;  // progress exists that is only in the autosave

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

const SAVE_VERSION = 2;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const elements = {
    startButton: document.getElementById('start-button'),
    restartButton: document.getElementById('restart-button'),
    saveButton: document.getElementById('save-button'),
    loadButton: document.getElementById('load-button'),
    exportButton: document.getElementById('export-button'),
    journalToggle: document.getElementById('journal-toggle'),
    loading: document.getElementById('loading'),
    narrativeDisplay: document.getElementById('narrative-display'),
    narrativeText: document.getElementById('narrative-text'),
    locationInfo: document.getElementById('location-info'),
    choicesContainer: document.getElementById('choices-container'),
    choicesGrid: document.querySelector('.choices-grid'),
    saveStatus: document.getElementById('save-status'),
    dreamJournal: document.getElementById('dream-journal'),
    journalPath: document.getElementById('journal-path'),
    stepCountEl: document.getElementById('step-count'),
    dreamCountEl: document.getElementById('dream-count'),
    timeElapsedEl: document.getElementById('time-elapsed'),
    closeJournal: document.getElementById('close-journal'),
    heroSection: document.getElementById('hero-section')
};

// Event Listeners
elements.startButton.addEventListener('click', startGame);
elements.restartButton.addEventListener('click', restartGame);
elements.saveButton.addEventListener('click', saveGame);
elements.loadButton.addEventListener('click', showLoadMenu);
elements.exportButton.addEventListener('click', exportJourney);
elements.journalToggle.addEventListener('click', toggleJournal);
elements.closeJournal.addEventListener('click', toggleJournal);

// Initialize
createMistParticles();
migrateLegacySaves();
elements.loadButton.classList.remove('hidden'); // always available: it also imports save files
showContinueButton();

// ===== SMALL HELPERS =====

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function setBusy(value) {
    busy = value;
    elements.saveButton.disabled = value;
    elements.loadButton.disabled = value;
    elements.startButton.disabled = value;
    const continueBtn = document.getElementById('load-autosave-button');
    if (continueBtn) continueBtn.disabled = value;
}

// ===== DIALOGS =====
// Drawn on the page rather than using the browser's alert/confirm/prompt
// pop-ups, which some phone browsers block.

function showDialog({ title, message, input, buttons }) {
    return new Promise(resolve => {
        const overlay = el('div', 'load-menu dialog-overlay');
        const box = el('div', 'load-menu-content dialog-content');
        box.appendChild(el('h2', '', title));
        if (message) box.appendChild(el('p', 'dialog-message', message));

        let inputEl = null;
        if (input) {
            inputEl = el('input', 'dialog-input');
            inputEl.type = 'text';
            inputEl.maxLength = 80;
            inputEl.value = input.value || '';
            box.appendChild(inputEl);
        }

        const finish = value => {
            overlay.remove();
            resolve({ button: value, value: inputEl ? inputEl.value : undefined });
        };

        const row = el('div', 'dialog-buttons');
        buttons.forEach(button => {
            const btn = el('button', button.className || 'close-menu-btn', button.label);
            btn.addEventListener('click', () => finish(button.value));
            row.appendChild(btn);
        });
        box.appendChild(row);

        if (inputEl) {
            inputEl.addEventListener('keydown', event => {
                if (event.key === 'Enter') finish(buttons[0].value);
            });
        }

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        if (inputEl) {
            inputEl.focus();
            inputEl.select();
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
            { label: okLabel, value: true, className: 'close-menu-btn dialog-primary' },
            { label: 'Cancel', value: false }
        ]
    });
    return result.button === true;
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

const STORAGE_PROBLEM = 'Your browser would not store the save. Its storage may be full, or blocked (for example in private browsing). You can still keep this journey with Load → Download.';

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

    // The story currently on screen must offer choices, or play cannot go on.
    const current = turns.length ? turns[turns.length - 1].story : opening;
    if (current.choices.length === 0) return null;

    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
        startTime: Number.isFinite(raw.startTime) ? raw.startTime : Date.now(),
        opening,
        turns
    };
}

function isDreaming(story) {
    return story.metadata.dreamState === 'dreaming';
}

// ===== PUTTING A JOURNEY ON SCREEN =====

function syncDerived() {
    currentStory = game.turns.length ? game.turns[game.turns.length - 1].story : game.opening;
    startTime = game.startTime;
    stepCount = game.turns.length;
    dreamCount = game.turns.filter(turn => isDreaming(turn.story)).length;
    journalEntries = game.turns.map((turn, i) => ({
        step: i + 1,
        choice: turn.choice,
        location: turn.story.metadata.location,
        dreamState: turn.story.metadata.dreamState,
        narrative: turn.story.narrative,
        timestamp: turn.at
    }));
}

// Redraw everything from `game`.
function renderGame() {
    syncDerived();

    startTimeTracking();
    updateStepCount();
    updateDreamCount();
    renderJournal();

    hideLoading();
    displayStory(currentStory);
    updateBackgroundColor(currentStory.metadata);

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
        const response = await fetch('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const story = await readStoryResponse(response);
        if (epoch !== gameEpoch) return; // a different journey was loaded meanwhile

        applyGame({ id: newId(), startTime: Date.now(), opening: story, turns: [] });
        unsavedProgress = false;
        autosave();
    } catch (error) {
        console.error('Error starting game:', error);
        hideLoading();
        showMessage('The journey could not begin', error.userMessage || 'Please refresh and try again.');
    } finally {
        setBusy(false);
    }
}

// Read a story reply from the server. Throws (with a message that is safe to
// show the player in error.userMessage) if the server reported an error or
// sent back something that isn't a usable story.
async function readStoryResponse(response) {
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

async function makeChoice(choice, index) {
    if (busy || !game) return;

    const epoch = gameEpoch;
    setBusy(true);
    showLoading();

    // Scroll to top immediately when choice is made
    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
        const response = await fetch('/api/continue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                opening: game.opening,
                turns: game.turns.map(turn => ({
                    choice: turn.choice,
                    choiceIndex: turn.choiceIndex,
                    story: turn.story
                })),
                choice,
                choiceIndex: index
            })
        });

        // Throws if the server failed, so nothing below (journal, step count,
        // autosave) runs for a choice that didn't go through.
        const story = await readStoryResponse(response);
        if (epoch !== gameEpoch) return; // a different journey was loaded meanwhile

        game.turns.push({ choice, choiceIndex: index, story, at: new Date().toISOString() });
        unsavedProgress = true;
        renderGame();
        autosave();
    } catch (error) {
        console.error('Error continuing story:', error);
        hideLoading();
        // Bring the current choices back so the player can try again
        if (epoch === gameEpoch && currentStory?.choices?.length) {
            elements.choicesContainer.classList.remove('hidden');
        }
        showMessage('The mist obscures the path', error.userMessage || 'Please try again.');
    } finally {
        setBusy(false);
    }
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

function displayStory(story) {
    const dreamIcon = isDreaming(story) ? '💭' : '👁️';
    elements.locationInfo.textContent = '';
    elements.locationInfo.append(
        `${dreamIcon} `, el('strong', '', 'Location:'), ` ${story.metadata.location} | `,
        el('strong', '', 'State:'), ` ${story.metadata.dreamState} | `,
        el('strong', '', 'Atmosphere:'), ` ${story.metadata.atmosphere}`
    );

    // Display text instantly
    elements.narrativeText.textContent = story.narrative;
    displayChoices(story.choices);
}

function displayChoices(choices) {
    elements.choicesGrid.textContent = '';

    choices.forEach((choice, index) => {
        const button = el('button', 'choice-btn');
        button.append(el('span', 'choice-number', String(index + 1)), ` ${choice}`);
        button.addEventListener('click', () => makeChoice(choice, index));
        elements.choicesGrid.appendChild(button);
    });

    elements.choicesContainer.classList.remove('hidden');
}

function showLoading() {
    elements.loading.classList.remove('hidden');
    elements.choicesContainer.classList.add('hidden');
}

function hideLoading() {
    elements.loading.classList.add('hidden');
}

// ===== JOURNAL FUNCTIONS =====

function updateStepCount() {
    elements.stepCountEl.textContent = stepCount;
}

function updateDreamCount() {
    elements.dreamCountEl.textContent = dreamCount;
}

function startTimeTracking() {
    const update = () => {
        const elapsed = Math.floor((Date.now() - startTime) / 60000); // minutes
        elements.timeElapsedEl.textContent = elapsed + 'm';
    };
    if (timeInterval) clearInterval(timeInterval);
    update();
    timeInterval = setInterval(update, 10000); // Update every 10 seconds
}

// Rebuild the journal list from journalEntries.
function renderJournal() {
    elements.journalPath.textContent = '';

    if (journalEntries.length === 0) {
        elements.journalPath.appendChild(el('p', 'journal-empty', 'Your path will be recorded here...'));
        return;
    }

    journalEntries.forEach(entry => {
        const dreamIcon = entry.dreamState === 'dreaming' ? '💭' : '👁️';
        const entryEl = el('div', 'journal-entry');
        const header = el('div', 'journal-entry-header');
        header.append(
            el('span', 'journal-step', `${dreamIcon} Step ${entry.step}`),
            el('span', 'journal-location', entry.location)
        );
        entryEl.append(header, el('div', 'journal-choice', `"${entry.choice}"`));
        elements.journalPath.appendChild(entryEl);
    });

    // Auto-scroll to latest entry
    elements.journalPath.scrollTop = elements.journalPath.scrollHeight;
}

function toggleJournal() {
    elements.dreamJournal.classList.toggle('hidden');
    
    // Update button text
    if (elements.dreamJournal.classList.contains('hidden')) {
        elements.journalToggle.innerHTML = '📔 Journal';
    } else {
        elements.journalToggle.innerHTML = '📔 Close Journal';
    }
}

// ===== EXPORT JOURNEY =====

function exportJourney() {
    if (journalEntries.length === 0) {
        showMessage('Nothing to export', 'No journey to export yet.');
        return;
    }
    
    showExportMenu();
}

function showExportMenu() {
    const modal = document.createElement('div');
    modal.className = 'load-menu';
    modal.innerHTML = `
        <div class="load-menu-content">
            <h2>Export Journey</h2>
            <p style="text-align: center; color: #b8b8b8; margin-bottom: 2rem;">Choose your preferred format:</p>
            <div class="export-format-grid">
                <button onclick="exportAsMarkdown()" class="export-format-btn">
                    <span class="format-icon">📝</span>
                    <span class="format-name">Markdown</span>
                    <span class="format-desc">.md - For note apps</span>
                </button>
                <button onclick="exportAsPDF()" class="export-format-btn">
                    <span class="format-icon">📄</span>
                    <span class="format-name">PDF</span>
                    <span class="format-desc">.pdf - Formatted document</span>
                </button>
                <button onclick="exportAsText()" class="export-format-btn">
                    <span class="format-icon">📋</span>
                    <span class="format-name">Plain Text</span>
                    <span class="format-desc">.txt - Simple text file</span>
                </button>
                <button onclick="exportAsHTML()" class="export-format-btn">
                    <span class="format-icon">🌐</span>
                    <span class="format-name">HTML</span>
                    <span class="format-desc">.html - Web page</span>
                </button>
            </div>
            <button onclick="closeExportMenu()" class="close-menu-btn" style="margin-top: 1rem;">Cancel</button>
        </div>
    `;
    
    document.body.appendChild(modal);
}

function closeExportMenu() {
    const menu = document.querySelector('.load-menu');
    if (menu) menu.remove();
}

function exportAsMarkdown() {
    let markdown = `# WuTong Mountain Journey\n## 梧桐山 - The Dream Doctor's Path\n\n`;
    markdown += `**Journey Statistics:**\n`;
    markdown += `- Steps Taken: ${stepCount}\n`;
    markdown += `- Dreams Entered: ${dreamCount}\n`;
    markdown += `- Started: ${new Date(startTime).toLocaleString()}\n`;
    markdown += `- Duration: ${Math.floor((Date.now() - startTime) / 60000)} minutes\n\n`;
    markdown += `---\n\n`;
    
    journalEntries.forEach((entry) => {
        markdown += `## Step ${entry.step}: ${entry.location}\n\n`;
        markdown += `**State:** ${entry.dreamState === 'dreaming' ? '💭 Dreaming' : '👁️ Waking'}\n\n`;
        markdown += `**Choice Made:**\n> ${entry.choice}\n\n`;
        markdown += `**What Happened:**\n\n${entry.narrative}\n\n`;
        markdown += `---\n\n`;
    });
    
    markdown += `\n*Generated from WuTong Mountain*\n*A journey without destination | 無為*`;
    
    downloadFile(markdown, `wutong-journey-${getDateString()}.md`, 'text/markdown');
    closeExportMenu();
    showSaveStatus('Journey exported as Markdown');
}

function exportAsPDF() {
    const htmlContent = generateHTMLContent();
    
    const printWindow = window.open('', '_blank');
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    
    setTimeout(() => {
        printWindow.print();
    }, 500);
    
    closeExportMenu();
    showSaveStatus('Opening print dialog - save as PDF');
}

function exportAsText() {
    let text = `WuTong Mountain Journey\n梧桐山 - The Dream Doctor's Path\n\n`;
    text += `Journey Statistics:\n`;
    text += `- Steps Taken: ${stepCount}\n`;
    text += `- Dreams Entered: ${dreamCount}\n`;
    text += `- Started: ${new Date(startTime).toLocaleString()}\n`;
    text += `- Duration: ${Math.floor((Date.now() - startTime) / 60000)} minutes\n\n`;
    text += `${'='.repeat(60)}\n\n`;
    
    journalEntries.forEach((entry) => {
        text += `Step ${entry.step}: ${entry.location}\n`;
        text += `State: ${entry.dreamState === 'dreaming' ? 'Dreaming' : 'Waking'}\n\n`;
        text += `Choice Made:\n  "${entry.choice}"\n\n`;
        text += `What Happened:\n${entry.narrative}\n\n`;
        text += `${'-'.repeat(60)}\n\n`;
    });
    
    text += `\nGenerated from WuTong Mountain\nA journey without destination | 無為`;
    
    downloadFile(text, `wutong-journey-${getDateString()}.txt`, 'text/plain');
    closeExportMenu();
    showSaveStatus('Journey exported as Text');
}

function exportAsHTML() {
    const htmlContent = generateHTMLContent();
    
    downloadFile(htmlContent, `wutong-journey-${getDateString()}.html`, 'text/html');
    closeExportMenu();
    showSaveStatus('Journey exported as HTML');
}

function generateHTMLContent() {
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WuTong Mountain Journey</title>
    <style>
        body {
            font-family: Georgia, 'Times New Roman', serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 2rem;
            background: linear-gradient(to bottom, #0a0e27 0%, #1a1a2e 50%, #16213e 100%);
            color: #e8e8e8;
            line-height: 1.8;
        }
        h1 {
            color: #ffd700;
            text-align: center;
            font-weight: 300;
            letter-spacing: 0.2rem;
            margin-bottom: 0.5rem;
        }
        h2 {
            color: #ffd700;
            font-weight: 300;
            letter-spacing: 0.15rem;
            text-align: center;
            font-size: 1.2rem;
            margin-bottom: 2rem;
            font-style: italic;
        }
        .stats {
            background: rgba(255, 215, 0, 0.1);
            border-left: 3px solid rgba(255, 215, 0, 0.5);
            padding: 1rem;
            margin: 2rem 0;
        }
        .stats strong {
            color: #ffd700;
        }
        .entry {
            background: rgba(255, 255, 255, 0.03);
            padding: 1.5rem;
            margin: 2rem 0;
            border-radius: 4px;
            border-left: 3px solid rgba(255, 215, 0, 0.3);
        }
        .entry-header {
            color: #ffd700;
            font-size: 1.2rem;
            margin-bottom: 1rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .state {
            font-size: 0.9rem;
            color: #888;
        }
        .choice {
            background: rgba(255, 215, 0, 0.05);
            padding: 1rem;
            margin: 1rem 0;
            border-left: 2px solid rgba(255, 215, 0, 0.3);
            font-style: italic;
        }
        .narrative {
            margin-top: 1rem;
            white-space: pre-line;
        }
        .footer {
            text-align: center;
            margin-top: 3rem;
            padding-top: 2rem;
            border-top: 1px solid rgba(255, 215, 0, 0.2);
            color: #888;
            font-style: italic;
        }
        @media print {
            body {
                background: white;
                color: black;
            }
            h1, h2, .entry-header, strong {
                color: #000;
            }
            .stats {
                background: #f5f5f5;
                border-left-color: #333;
            }
            .entry {
                background: #fafafa;
                border-left-color: #666;
            }
        }
    </style>
</head>
<body>
    <h1>WuTong Mountain Journey</h1>
    <h2>梧桐山 | The Dream Doctor's Path</h2>
    
    <div class="stats">
        <strong>Journey Statistics:</strong><br>
        Steps Taken: ${stepCount}<br>
        Dreams Entered: ${dreamCount}<br>
        Started: ${new Date(startTime).toLocaleString()}<br>
        Duration: ${Math.floor((Date.now() - startTime) / 60000)} minutes
    </div>
`;

    journalEntries.forEach((entry) => {
        const dreamIcon = entry.dreamState === 'dreaming' ? '💭' : '👁️';
        html += `
    <div class="entry">
        <div class="entry-header">
            <span>${dreamIcon} Step ${entry.step}: ${entry.location}</span>
            <span class="state">${entry.dreamState === 'dreaming' ? 'Dreaming' : 'Waking'}</span>
        </div>
        <div class="choice">
            <strong>Choice Made:</strong><br>
            "${entry.choice}"
        </div>
        <div class="narrative">
            <strong>What Happened:</strong><br><br>
            ${entry.narrative}
        </div>
    </div>
`;
    });

    html += `
    <div class="footer">
        Generated from WuTong Mountain<br>
        A journey without destination | 無為
    </div>
</body>
</html>`;

    return html;
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function getDateString() {
    return new Date().toISOString().slice(0, 10);
}

// ===== VISUAL EFFECTS =====

function updateBackgroundColor(metadata) {
    const body = document.body;
    
    if (metadata.dreamState === 'dreaming') {
        const isDark = metadata.atmosphere?.toLowerCase().includes('dark') ||
                      metadata.atmosphere?.toLowerCase().includes('nightmare');
        
        if (isDark) {
            body.style.background = 'linear-gradient(to bottom, #1a0a2e 0%, #2d1b3d 50%, #1a0a2e 100%)';
        } else {
            body.style.background = 'linear-gradient(to bottom, #0a1a3e 0%, #1e3a5f 50%, #2a4a7f 100%)';
        }
    } else {
        body.style.background = 'linear-gradient(to bottom, #0a0e27 0%, #1a1a2e 50%, #16213e 100%)';
    }
    
    body.style.transition = 'background 3s ease';
}

function createMistParticles() {
    const container = document.getElementById('mist-particles');
    const particleCount = 30;
    
    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        particle.className = 'mist-particle';
        
        particle.style.left = Math.random() * 100 + '%';
        particle.style.top = Math.random() * 100 + '%';
        
        const size = Math.random() * 60 + 20;
        particle.style.width = size + 'px';
        particle.style.height = size + 'px';
        
        const duration = Math.random() * 20 + 30;
        particle.style.animationDuration = duration + 's';
        
        const delay = Math.random() * 10;
        particle.style.animationDelay = delay + 's';
        
        container.appendChild(particle);
    }
}

// ===== SAVE/LOAD FUNCTIONS =====
//
// A save is { app, version, id, name, savedAt, game }. The autosave and the
// manual saves use this same shape, as do downloaded save files. Saving and
// loading only read and write the browser's storage - no server involved.

function makeSaveRecord(name) {
    return {
        app: 'wutong-mountain',
        version: SAVE_VERSION,
        id: newId(),
        name,
        savedAt: new Date().toISOString(),
        game
    };
}

// Returns a usable save record, or null if the stored data is damaged.
function cleanSaveRecord(raw) {
    const cleaned = cleanGame(raw && raw.game);
    if (!cleaned) return null;
    return {
        app: 'wutong-mountain',
        version: SAVE_VERSION,
        id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Unnamed journey',
        savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
        game: cleaned
    };
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
    const turns = record.game.turns;
    const current = turns.length ? turns[turns.length - 1].story : record.game.opening;
    const steps = turns.length === 1 ? '1 step' : `${turns.length} steps`;
    return `${current.metadata.location}, ${steps}`;
}

function formatDate(iso) {
    const date = new Date(iso);
    return isNaN(date) ? 'Unknown date' : date.toLocaleString();
}

// Runs after every successful choice.
function autosave() {
    if (!game) return;

    const record = makeSaveRecord('Autosave');
    record.id = 'autosave';

    if (!storeSet(STORE.autosave, record)) {
        showSaveStatus('⚠ Autosave failed - browser storage is full or blocked');
        return;
    }

    // Show brief autosave indicator
    const indicator = el('div', 'autosave-indicator', '💾 Autosaved');
    document.body.appendChild(indicator);
    setTimeout(() => {
        indicator.classList.add('fade-out');
        setTimeout(() => indicator.remove(), 500);
    }, 1500);
}

async function saveGame() {
    if (busy) return;
    if (!game) {
        showMessage('Nothing to save', 'No journey to save yet.');
        return;
    }

    const result = await showDialog({
        title: 'Save Journey',
        message: 'Name this point in your journey:',
        input: { value: `Journey ${new Date().toLocaleString()}` },
        buttons: [
            { label: 'Save', value: true, className: 'close-menu-btn dialog-primary' },
            { label: 'Cancel', value: false }
        ]
    });
    if (result.button !== true) return;

    const name = (result.value || '').trim().slice(0, 80) || `Journey ${new Date().toLocaleString()}`;
    const record = makeSaveRecord(name);

    if (!storeSet(STORE.savePrefix + record.id, record)) {
        showMessage('Save failed', STORAGE_PROBLEM);
        return;
    }

    unsavedProgress = false;
    showSaveStatus('Journey saved: ' + name);
}

// The "Continue Journey" button on the opening screen.
function showContinueButton() {
    document.getElementById('load-autosave-button')?.remove();
    if (game || !readAutosave()) return;

    const button = el('button', 'control-btn autosave-btn', '🔄 Continue Journey');
    button.id = 'load-autosave-button';
    button.addEventListener('click', () => {
        const record = readAutosave();
        if (record) loadSave(record, true);
    });
    elements.startButton.parentNode.insertBefore(button, elements.startButton.nextSibling);
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
    showSaveStatus(isAutosave ? 'Journey continued from autosave' : 'Journey loaded: ' + record.name);
}

async function deleteSave(record) {
    const ok = await confirmDialog('Delete saved journey?', `"${record.name}" will be permanently deleted.`, 'Delete');
    if (!ok) return;

    storeRemove(record.key);
    showLoadMenu();
    showSaveStatus('Journey deleted: ' + record.name);
}

// ----- Save files (backup, and moving a journey between devices) -----

function downloadSave(record) {
    const { key, ...fileRecord } = record;
    const slug = record.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'journey';
    downloadFile(JSON.stringify(fileRecord, null, 2), `wutong-save-${slug}-${getDateString()}.json`, 'application/json');
    showSaveStatus('Save file downloaded: ' + record.name);
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
        showSaveStatus('Save file added: ' + record.name);
    };
    reader.readAsText(file);
}

// ----- Load menu -----

function showLoadMenu() {
    closeLoadMenu();

    const menu = el('div', 'load-menu');
    menu.id = 'load-menu';
    const content = el('div', 'load-menu-content');
    content.appendChild(el('h2', '', 'Saved Journeys'));

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
        info.append(el('strong', '', String(name)), el('small', '', 'Older save that could not be converted. The original is still stored in this browser.'));
        item.appendChild(info);
        list.appendChild(item);
    });

    content.appendChild(list);

    // Load from a downloaded save file
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => importSaveFile(fileInput.files[0]));

    const importBtn = el('button', 'close-menu-btn', '📂 Load from file');
    importBtn.addEventListener('click', () => fileInput.click());

    const closeBtn = el('button', 'close-menu-btn', 'Close');
    closeBtn.addEventListener('click', closeLoadMenu);

    const footer = el('div', 'dialog-buttons');
    footer.append(importBtn, closeBtn);
    content.append(fileInput, footer);
    content.appendChild(el('p', 'save-hint', 'Saves are kept in this browser only, and browsers can clear them. Use Download to keep a backup file or move a journey to another device.'));

    menu.appendChild(content);
    document.body.appendChild(menu);
}

function buildSaveItem(record, isAutosave) {
    const turns = record.game.turns;
    const current = turns.length ? turns[turns.length - 1].story : record.game.opening;
    const dreams = turns.filter(turn => isDreaming(turn.story)).length;

    const item = el('div', isAutosave ? 'save-item autosave-item' : 'save-item');

    const info = el('div', 'save-info');
    info.append(
        el('strong', '', isAutosave ? '🔄 Autosave (Latest)' : record.name),
        el('small', '', formatDate(record.savedAt)),
        el('small', '', `Location: ${current.metadata.location}`),
        el('small', '', `Steps: ${turns.length} | Dreams: ${dreams}`)
    );

    const actions = el('div', 'save-actions');

    const loadBtn = el('button', 'load-btn', 'Load');
    loadBtn.addEventListener('click', () => loadSave(record, isAutosave));

    const downloadBtn = el('button', 'load-btn', 'Download');
    downloadBtn.addEventListener('click', () => downloadSave(record));

    actions.append(loadBtn, downloadBtn);

    if (!isAutosave) {
        const deleteBtn = el('button', 'delete-btn', 'Delete');
        deleteBtn.addEventListener('click', () => deleteSave(record));
        actions.appendChild(deleteBtn);
    }

    item.append(info, actions);
    return item;
}

function closeLoadMenu() {
    document.getElementById('load-menu')?.remove();
}

function showSaveStatus(message) {
    elements.saveStatus.textContent = message;
    elements.saveStatus.classList.add('show');
    setTimeout(() => {
        elements.saveStatus.classList.remove('show');
    }, 3000);
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
        const converted = convertLegacySave(legacy);
        if (!converted) {
            unreadable.push(name);
            return;
        }
        const record = {
            app: 'wutong-mountain',
            version: SAVE_VERSION,
            id: key,
            name,
            savedAt: typeof legacy.savedAt === 'string' ? legacy.savedAt : new Date().toISOString(),
            game: converted
        };
        if (!storeSet(key, record)) storageFailed = true;
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

// Used by the inline onclick handlers in the export menu
window.exportAsMarkdown = exportAsMarkdown;
window.exportAsPDF = exportAsPDF;
window.exportAsText = exportAsText;
window.exportAsHTML = exportAsHTML;
window.closeExportMenu = closeExportMenu;
