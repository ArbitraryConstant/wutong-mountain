let sessionId = null;
let currentStory = null;
let journalEntries = [];
let stepCount = 0;
let dreamCount = 0;
let startTime = null;
let timeInterval = null;

const AUTOSAVE_KEY = 'wutongMountainAutosave';

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
elements.restartButton.addEventListener('click', () => {
    if (confirm('Return to the mountain and begin anew? Your current journey will be lost unless saved.')) {
        clearAutosave();
        location.reload();
    }
});
elements.saveButton.addEventListener('click', saveGame);
elements.loadButton.addEventListener('click', showLoadMenu);
elements.exportButton.addEventListener('click', exportJourney);
elements.journalToggle.addEventListener('click', toggleJournal);
elements.closeJournal.addEventListener('click', toggleJournal);

// Initialize particles
createMistParticles();

// Check for autosave on page load
checkForAutosave();

function checkForAutosave() {
    const autosave = localStorage.getItem(AUTOSAVE_KEY);
    if (autosave) {
        // Show Continue Journey button
        const loadAutosaveBtn = document.createElement('button');
        loadAutosaveBtn.id = 'load-autosave-button';
        loadAutosaveBtn.className = 'control-btn autosave-btn';
        loadAutosaveBtn.innerHTML = '🔄 Continue Journey';
        loadAutosaveBtn.addEventListener('click', loadAutosave);
        
        // Insert after start button
        elements.startButton.parentNode.insertBefore(loadAutosaveBtn, elements.startButton.nextSibling);
        
        // Also show Load button since autosave exists
        updateLoadButtonVisibility();
    }
}

async function loadAutosave() {
    try {
        const autosaveStr = localStorage.getItem(AUTOSAVE_KEY);
        if (!autosaveStr) {
            throw new Error('No autosave found');
        }
        
        const autosave = JSON.parse(autosaveStr);
        
        console.log('Loading autosave:', autosave);
        
        showLoading();
        elements.heroSection.classList.add('hidden');
        document.getElementById('load-autosave-button')?.remove();
        
        // Validate the autosave structure
        if (!autosave.sessionData || !autosave.sessionData.currentState) {
            throw new Error('Autosave is missing required data');
        }
        
        const response = await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: autosave.sessionId,
                sessionData: autosave.sessionData
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `Server error: ${response.status}`);
        }
        
        const data = await response.json();
        
        sessionId = autosave.sessionId;
        currentStory = data.story;
        journalEntries = autosave.journalEntries || [];
        stepCount = autosave.stepCount || 0;
        dreamCount = autosave.dreamCount || 0;
        startTime = autosave.startTime || Date.now();
        
        startTimeTracking();
        updateStepCount();
        updateDreamCount();
        
        // Rebuild journal display
        elements.journalPath.innerHTML = '';
        journalEntries.forEach(entry => {
            const dreamIcon = entry.dreamState === 'dreaming' ? '💭' : '👁️';
            const entryEl = document.createElement('div');
            entryEl.className = 'journal-entry';
            entryEl.innerHTML = `
                <div class="journal-entry-header">
                    <span class="journal-step">${dreamIcon} Step ${entry.step}</span>
                    <span class="journal-location">${entry.location}</span>
                </div>
                <div class="journal-choice">"${entry.choice}"</div>
            `;
            elements.journalPath.appendChild(entryEl);
        });
        
        hideLoading();
        displayStoryInstant(currentStory);
        
        elements.startButton.classList.add('hidden');
        elements.restartButton.classList.remove('hidden');
        elements.saveButton.classList.remove('hidden');
        elements.exportButton.classList.remove('hidden');
        elements.journalToggle.classList.remove('hidden');
        
        updateLoadButtonVisibility();
        updateBackgroundColor(currentStory.metadata);
        
        showSaveStatus('Journey continued from autosave');
        
    } catch (error) {
        console.error('Error loading autosave:', error);
        alert('Failed to load autosave: ' + error.message);
        clearAutosave();
        document.getElementById('load-autosave-button')?.remove();
        elements.heroSection.classList.remove('hidden');
        elements.startButton.classList.remove('hidden');
        hideLoading();
    }
}

async function loadAutosaveFromMenu() {
    closeLoadMenu();
    
    // Stop any ongoing typewriter animation
    elements.narrativeText.textContent = '';
    
    await loadAutosave();
}

async function loadGame(saveName) {
    const saves = getSavedGames();
    const save = saves[saveName];
    
    if (!save) {
        alert('Save not found.');
        return;
    }
    
    try {
        // Stop any ongoing typewriter animation
        elements.narrativeText.textContent = '';
        
        showLoading();
        closeLoadMenu();
        
        elements.heroSection.classList.add('hidden');
        document.getElementById('load-autosave-button')?.remove();
        
        let actualSessionData = save.sessionData;
        
        if (actualSessionData && actualSessionData.sessionData) {
            actualSessionData = actualSessionData.sessionData;
        }
        
        if (!actualSessionData || !actualSessionData.history) {
            actualSessionData = {
                history: [],
                currentState: save.sessionData.currentState || save.sessionData.story || {},
                choices: save.journalEntries || []
            };
        }
        
        const response = await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: save.sessionId,
                sessionData: actualSessionData
            })
        });
        
        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }
        
        const data = await response.json();
        
        sessionId = save.sessionId;
        currentStory = data.story;
        journalEntries = save.journalEntries || [];
        stepCount = save.stepCount || 0;
        dreamCount = save.dreamCount || 0;
        startTime = save.startTime || Date.now();
        
        startTimeTracking();
        updateStepCount();
        updateDreamCount();
        
        // Rebuild journal display
        elements.journalPath.innerHTML = '';
        journalEntries.forEach(entry => {
            const dreamIcon = entry.dreamState === 'dreaming' ? '💭' : '👁️';
            const entryEl = document.createElement('div');
            entryEl.className = 'journal-entry';
            entryEl.innerHTML = `
                <div class="journal-entry-header">
                    <span class="journal-step">${dreamIcon} Step ${entry.step}</span>
                    <span class="journal-location">${entry.location}</span>
                </div>
                <div class="journal-choice">"${entry.choice}"</div>
            `;
            elements.journalPath.appendChild(entryEl);
        });
        
        hideLoading();
        
        // Display without typewriter animation when loading
        displayStoryInstant(currentStory);
        
        elements.startButton.classList.add('hidden');
        elements.restartButton.classList.remove('hidden');
        elements.saveButton.classList.remove('hidden');
        elements.exportButton.classList.remove('hidden');
        elements.journalToggle.classList.remove('hidden');
        
        updateBackgroundColor(currentStory.metadata);
        
        // Update autosave with loaded game
        await performAutosave();
        
        showSaveStatus('Journey loaded: ' + saveName);
        
    } catch (error) {
        console.error('Error loading game:', error);
        alert('Failed to load journey. The path is unclear... Error: ' + error.message);
        hideLoading();
        
        elements.startButton.classList.remove('hidden');
        elements.heroSection.classList.remove('hidden');
    }
}

function clearAutosave() {
    localStorage.removeItem(AUTOSAVE_KEY);
}

async function performAutosave() {
    if (!sessionId || !currentStory) return;
    
    try {
        const response = await fetch(`/api/session/${sessionId}`);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch session: ${response.status}`);
        }
        
        const sessionData = await response.json();
        
        // Build the autosave with the correct structure
        const autosaveData = {
            sessionId,
            sessionData: {
                history: sessionData.sessionData?.history || [],
                currentState: currentStory  // Use the current story as currentState
            },
            journalEntries,
            stepCount,
            dreamCount,
            startTime,
            savedAt: new Date().toISOString(),
            location: currentStory.metadata?.location || 'Unknown'
        };
        
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(autosaveData));
        
        // Update Load button visibility
        updateLoadButtonVisibility();
        
        // Show brief autosave indicator
        const indicator = document.createElement('div');
        indicator.className = 'autosave-indicator';
        indicator.textContent = '💾 Autosaved';
        document.body.appendChild(indicator);
        
        setTimeout(() => {
            indicator.classList.add('fade-out');
            setTimeout(() => indicator.remove(), 500);
        }, 1500);
        
    } catch (error) {
        console.error('Autosave failed:', error);
        console.error('SessionId:', sessionId);
        console.error('CurrentStory:', currentStory);
    }
}

async function startGame() {
    try {
        showLoading();
        
        const response = await fetch('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        sessionId = data.sessionId;
        currentStory = data.story;
        
        // Initialize journey tracking
        journalEntries = [];
        stepCount = 0;
        dreamCount = 0;
        startTime = Date.now();
        startTimeTracking();
        
        // Clear old autosave and create new one
        clearAutosave();
        await performAutosave();
        
        hideLoading();
        displayStory(currentStory);
        
        // Hide hero image and autosave button
        elements.heroSection.classList.add('hidden');
        document.getElementById('load-autosave-button')?.remove();
        
        elements.startButton.classList.add('hidden');
        elements.restartButton.classList.remove('hidden');
        elements.saveButton.classList.remove('hidden');
        elements.exportButton.classList.remove('hidden');
        elements.journalToggle.classList.remove('hidden');
        
        updateLoadButtonVisibility();
        
    } catch (error) {
        console.error('Error starting game:', error);
        alert('Failed to start the journey. Please refresh and try again.');
    }
}

async function makeChoice(choice, index) {
    try {
        showLoading();
        
        // Scroll to top immediately when choice is made
        window.scrollTo({ top: 0, behavior: 'smooth' });
        
        const response = await fetch('/api/continue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId,
                choice,
                choiceIndex: index
            })
        });
        
        const data = await response.json();
        currentStory = data.story;
        
        // Track this choice in journal
        stepCount++;
        journalEntries.push({
            step: stepCount,
            choice: choice,
            location: currentStory.metadata?.location || 'Unknown',
            dreamState: currentStory.metadata?.dreamState || 'waking',
            narrative: currentStory.narrative,
            timestamp: new Date().toISOString()
        });
        
        // Count dreams entered
        if (currentStory.metadata?.dreamState === 'dreaming') {
            dreamCount++;
            updateDreamCount();
        }
        
        updateStepCount();
        updateJournalPath();
        
        // Autosave after each choice
        await performAutosave();
        
        hideLoading();
        displayStory(currentStory);
        
        // Update background color based on state
        updateBackgroundColor(currentStory.metadata);
        
    } catch (error) {
        console.error('Error continuing story:', error);
        hideLoading();
        alert('The mist obscures the path. Please try again.');
    }
}

function displayStory(story) {
    if (story.metadata) {
        const dreamIcon = story.metadata.dreamState === 'dreaming' ? '💭' : '👁️';
        elements.locationInfo.innerHTML = `
            ${dreamIcon} <strong>Location:</strong> ${story.metadata.location} | 
            <strong>State:</strong> ${story.metadata.dreamState} | 
            <strong>Atmosphere:</strong> ${story.metadata.atmosphere}
        `;
    }
    
    elements.narrativeText.textContent = '';
    typeWriter(story.narrative, elements.narrativeText, () => {
        displayChoices(story.choices);
    });
}

function displayStoryInstant(story) {
    if (story.metadata) {
        const dreamIcon = story.metadata.dreamState === 'dreaming' ? '💭' : '👁️';
        elements.locationInfo.innerHTML = `
            ${dreamIcon} <strong>Location:</strong> ${story.metadata.location} | 
            <strong>State:</strong> ${story.metadata.dreamState} | 
            <strong>Atmosphere:</strong> ${story.metadata.atmosphere}
        `;
    }
    
    // Display text instantly without typewriter effect
    elements.narrativeText.textContent = story.narrative;
    displayChoices(story.choices);
}

function displayChoices(choices) {
    elements.choicesGrid.innerHTML = '';
    
    choices.forEach((choice, index) => {
        const button = document.createElement('button');
        button.className = 'choice-btn';
        button.innerHTML = `<span class="choice-number">${index + 1}</span> ${choice}`;
        button.addEventListener('click', () => makeChoice(choice, index));
        elements.choicesGrid.appendChild(button);
    });
    
    elements.choicesContainer.classList.remove('hidden');
}

function typeWriter(text, element, callback, speed = 15) {
    let i = 0;
    element.textContent = '';
    
    function type() {
        if (i < text.length) {
            element.textContent += text.charAt(i);
            i++;
            setTimeout(type, speed);
        } else if (callback) {
            callback();
        }
    }
    
    type();
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
    if (timeInterval) clearInterval(timeInterval);
    timeInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 60000); // minutes
        elements.timeElapsedEl.textContent = elapsed + 'm';
    }, 10000); // Update every 10 seconds
}

function updateJournalPath() {
    if (journalEntries.length === 0) return;
    
    const lastEntry = journalEntries[journalEntries.length - 1];
    const dreamIcon = lastEntry.dreamState === 'dreaming' ? '💭' : '👁️';
    
    const entryEl = document.createElement('div');
    entryEl.className = 'journal-entry';
    entryEl.innerHTML = `
        <div class="journal-entry-header">
            <span class="journal-step">${dreamIcon} Step ${lastEntry.step}</span>
            <span class="journal-location">${lastEntry.location}</span>
        </div>
        <div class="journal-choice">"${lastEntry.choice}"</div>
    `;
    
    // Remove empty message if exists
    const emptyMsg = elements.journalPath.querySelector('.journal-empty');
    if (emptyMsg) emptyMsg.remove();
    
    elements.journalPath.appendChild(entryEl);
    
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
        alert('No journey to export yet.');
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

async function saveGame() {
    if (!sessionId) {
        alert('No journey to save yet.');
        return;
    }
    
    try {
        const response = await fetch(`/api/session/${sessionId}`);
        const sessionData = await response.json();
        
        const saveName = prompt('Name this point in your journey:', `Journey ${new Date().toLocaleString()}`);
        if (!saveName) return;
        
        const saves = getSavedGames();
        saves[saveName] = {
            sessionId,
            sessionData,
            journalEntries,
            stepCount,
            dreamCount,
            startTime,
            savedAt: new Date().toISOString(),
            location: currentStory.metadata?.location || 'Unknown'
        };
        
        localStorage.setItem('wutongMountainSaves', JSON.stringify(saves));
        
        showSaveStatus('Journey saved: ' + saveName);
        updateLoadButtonVisibility();
        
    } catch (error) {
        console.error('Error saving game:', error);
        alert('Failed to save journey. The mist interferes...');
    }
}

function getSavedGames() {
    const saves = localStorage.getItem('wutongMountainSaves');
    return saves ? JSON.parse(saves) : {};
}

function showLoadMenu() {
    const saves = getSavedGames();
    const autosaveStr = localStorage.getItem(AUTOSAVE_KEY);
    
    // Build complete list of saves
    const allSaves = { ...saves };
    
    if (autosaveStr) {
        try {
            const autosaveData = JSON.parse(autosaveStr);
            allSaves['🔄 Autosave (Latest)'] = autosaveData;
        } catch (e) {
            console.error('Failed to parse autosave:', e);
        }
    }
    
    const saveNames = Object.keys(allSaves);
    
    if (saveNames.length === 0) {
        alert('No saved journeys found.');
        return;
    }
    
    const menu = document.createElement('div');
    menu.className = 'load-menu';
    menu.innerHTML = `
        <div class="load-menu-content">
            <h2>Saved Journeys</h2>
            <div class="save-list">
                ${saveNames.map(name => {
                    const save = allSaves[name];
                    const date = new Date(save.savedAt).toLocaleString();
                    const escapedName = name.replace(/'/g, "\\'");
                    const isAutosave = name === '🔄 Autosave (Latest)';
                    return `
                        <div class="save-item ${isAutosave ? 'autosave-item' : ''}">
                            <div class="save-info">
                                <strong>${name}</strong>
                                <small>${date}</small>
                                <small>Location: ${save.location}</small>
                                <small>Steps: ${save.stepCount || 0} | Dreams: ${save.dreamCount || 0}</small>
                            </div>
                            <div class="save-actions">
                                <button onclick="${isAutosave ? 'loadAutosaveFromMenu()' : `loadGame('${escapedName}')`}" class="load-btn">Load</button>
                                ${!isAutosave ? `<button onclick="deleteSave('${escapedName}')" class="delete-btn">Delete</button>` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
            <button onclick="closeLoadMenu()" class="close-menu-btn">Close</button>
        </div>
    `;
    
    document.body.appendChild(menu);
}

async function loadGame(saveName) {
    const saves = getSavedGames();
    const save = saves[saveName];
    
    if (!save) {
        alert('Save not found.');
        return;
    }
    
    try {
        showLoading();
        closeLoadMenu();
        
        elements.heroSection.classList.add('hidden');
        document.getElementById('load-autosave-button')?.remove();
        
        let actualSessionData = save.sessionData;
        
        if (actualSessionData && actualSessionData.sessionData) {
            actualSessionData = actualSessionData.sessionData;
        }
        
        if (!actualSessionData || !actualSessionData.history) {
            actualSessionData = {
                history: [],
                currentState: save.sessionData.currentState || save.sessionData.story || {},
                choices: save.journalEntries || []
            };
        }
        
        const response = await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: save.sessionId,
                sessionData: actualSessionData
            })
        });
        
        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }
        
        const data = await response.json();
        
        sessionId = save.sessionId;
        currentStory = data.story;
        journalEntries = save.journalEntries || [];
        stepCount = save.stepCount || 0;
        dreamCount = save.dreamCount || 0;
        startTime = save.startTime || Date.now();
        
        startTimeTracking();
        updateStepCount();
        updateDreamCount();
        
        // Rebuild journal display
        elements.journalPath.innerHTML = '';
        journalEntries.forEach(entry => {
            const dreamIcon = entry.dreamState === 'dreaming' ? '💭' : '👁️';
            const entryEl = document.createElement('div');
            entryEl.className = 'journal-entry';
            entryEl.innerHTML = `
                <div class="journal-entry-header">
                    <span class="journal-step">${dreamIcon} Step ${entry.step}</span>
                    <span class="journal-location">${entry.location}</span>
                </div>
                <div class="journal-choice">"${entry.choice}"</div>
            `;
            elements.journalPath.appendChild(entryEl);
        });
        
        hideLoading();
        displayStory(currentStory);
        
        elements.startButton.classList.add('hidden');
        elements.restartButton.classList.remove('hidden');
        elements.saveButton.classList.remove('hidden');
        elements.exportButton.classList.remove('hidden');
        elements.journalToggle.classList.remove('hidden');
        
        updateBackgroundColor(currentStory.metadata);
        
        // Update autosave with loaded game
        await performAutosave();
        
        showSaveStatus('Journey loaded: ' + saveName);
        
    } catch (error) {
        console.error('Error loading game:', error);
        alert('Failed to load journey. The path is unclear... Error: ' + error.message);
        hideLoading();
        
        elements.startButton.classList.remove('hidden');
        elements.heroSection.classList.remove('hidden');
    }
}

function deleteSave(saveName) {
    if (!confirm(`Delete saved journey "${saveName}"?`)) return;
    
    const saves = getSavedGames();
    delete saves[saveName];
    localStorage.setItem('wutongMountainSaves', JSON.stringify(saves));
    
    closeLoadMenu();
    updateLoadButtonVisibility();
    
    showSaveStatus('Journey deleted: ' + saveName);
}

function closeLoadMenu() {
    const menu = document.querySelector('.load-menu');
    if (menu) menu.remove();
}

function updateLoadButtonVisibility() {
    const saves = getSavedGames();
    const autosave = localStorage.getItem(AUTOSAVE_KEY);
    
    // Show load button if there are ANY saves (manual OR autosave)
    if (Object.keys(saves).length > 0 || autosave) {
        elements.loadButton.classList.remove('hidden');
    } else {
        elements.loadButton.classList.add('hidden');
    }
}

function showSaveStatus(message) {
    elements.saveStatus.textContent = message;
    elements.saveStatus.classList.add('show');
    setTimeout(() => {
        elements.saveStatus.classList.remove('show');
    }, 3000);
}

// Make functions globally accessible
window.loadGame = loadGame;
window.deleteSave = deleteSave;
window.closeLoadMenu = closeLoadMenu;
window.loadAutosaveFromMenu = loadAutosaveFromMenu;
window.exportAsMarkdown = exportAsMarkdown;
window.exportAsPDF = exportAsPDF;
window.exportAsText = exportAsText;
window.exportAsHTML = exportAsHTML;
window.closeExportMenu = closeExportMenu;

// Initialize
updateLoadButtonVisibility();