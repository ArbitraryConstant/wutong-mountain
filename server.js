// WuTong Mountain - web server.
//
// Serves the game page from public/ and asks Claude for each story segment.
// The server keeps no game state: the browser holds the whole journey and
// sends it with each choice, so restarts and redeploys cannot lose a game.

require('dotenv').config();
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, OPENING_NARRATIVE } = require('./src/storyEngine');

// ===== SETTINGS =====

const PORT = process.env.PORT || 3000;

// Default model; set CLAUDE_MODEL in the environment (e.g. on Railway) to override.
const MODEL = (process.env.CLAUDE_MODEL || '').trim() || 'claude-opus-5-5';

// Current models think before answering, and that thinking counts against
// max_tokens, so this needs plenty of headroom beyond the story itself.
const MAX_TOKENS = 16000;

// Give up on a single request to Claude after this long.
const CLAUDE_TIMEOUT_MS = 2 * 60 * 1000;

const START_PROMPT = 'Begin the story with the opening narrative and provide the first set of choices.';
const CHOICES_PER_STORY = 4;

// Limits on what the browser may send as "the journey so far".
const MAX_TURNS = 2000;
const MAX_NARRATIVE_CHARS = 20000;
const MAX_CHOICE_CHARS = 1000;

// Claude is sent the most recent turns word for word. On a very long journey,
// older turns are condensed to one line each, which keeps every request a
// manageable size and cost. The cut-off moves in steps so that consecutive
// requests share the same beginning, which Claude can then reuse cheaply.
const RECENT_TURNS_IN_FULL = 30;
const CONDENSE_STEP = 10;

// Each story request costs money, so one visitor may only make this many
// in each time window. Normal play is far below it.
const RATE_LIMIT_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

// ===== APP SETUP =====

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // the host (Railway) sits in front, so read the visitor's real address

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
        // Pictures rarely change; the page, script and styles must always be fresh.
        const isImage = /\.(png|jpe?g|ico|webp)$/i.test(filePath);
        res.setHeader('Cache-Control', isImage ? 'public, max-age=604800' : 'no-cache');
    }
}));

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: CLAUDE_TIMEOUT_MS
});

// ===== RATE LIMIT =====

const recentRequests = new Map(); // visitor address -> times of their recent story requests

function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const times = (recentRequests.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);

    if (times.length >= RATE_LIMIT_REQUESTS) {
        recentRequests.set(key, times);
        return res.status(429).json({ error: 'The mountain asks for patience. Please wait a few minutes before continuing.' });
    }

    times.push(now);
    recentRequests.set(key, times);
    next();
}

// Forget visitors who have gone quiet, so the list cannot grow without end.
setInterval(() => {
    const now = Date.now();
    for (const [key, times] of recentRequests) {
        if (times.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) recentRequests.delete(key);
    }
}, RATE_LIMIT_WINDOW_MS).unref();

// ===== STORY FORMAT =====

// The shape every story response must have. Sent to the API so the model's
// reply is guaranteed to be JSON in this structure.
const STORY_SCHEMA = {
    type: 'object',
    properties: {
        narrative: { type: 'string' },
        choices: { type: 'array', items: { type: 'string' } },
        metadata: {
            type: 'object',
            properties: {
                location: { type: 'string' },
                dreamState: { type: 'string', enum: ['waking', 'dreaming'] },
                atmosphere: { type: 'string' }
            },
            required: ['location', 'dreamState', 'atmosphere'],
            additionalProperties: false
        }
    },
    required: ['narrative', 'choices', 'metadata'],
    additionalProperties: false
};

// An error whose message is safe to show to the player.
class StoryError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

// Pull a JSON object out of the model's text, tolerating code fences or
// stray prose around it.
function extractJson(text) {
    const candidates = [text.trim()];

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) candidates.push(fenced[1].trim());

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (e) {
            // try the next candidate
        }
    }
    return null;
}

// Check the parsed story and tidy it into exactly the shape the frontend
// expects. Returns null if it is unusable.
//
// A freshly generated story must have exactly 4 choices. Earlier stories sent
// back by the browser (requireFourChoices = false) only need a narrative,
// because saves converted from the old format may lack their choice lists.
function normalizeStory(raw, requireFourChoices = true) {
    if (!raw || typeof raw.narrative !== 'string' || !raw.narrative.trim()) return null;
    if (raw.narrative.length > MAX_NARRATIVE_CHARS) return null;
    if (!Array.isArray(raw.choices)) return null;

    const choices = raw.choices
        .filter(c => typeof c === 'string' && c.trim() && c.length <= MAX_CHOICE_CHARS)
        .map(c => c.trim())
        .slice(0, CHOICES_PER_STORY);
    if (requireFourChoices && choices.length !== CHOICES_PER_STORY) return null;

    const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
    const text = (value, fallback) =>
        typeof value === 'string' && value.trim() ? value.trim() : fallback;

    return {
        narrative: raw.narrative.trim(),
        choices,
        metadata: {
            location: text(meta.location, 'Unknown'),
            dreamState: meta.dreamState === 'dreaming' ? 'dreaming' : 'waking',
            atmosphere: text(meta.atmosphere, 'uncertain')
        }
    };
}

// ===== TALKING TO CLAUDE =====

// Ask Claude for the next story segment. Returns the story, or throws.
async function generateStory(messages) {
    let lastProblem = 'unknown';

    // If the reply can't be used, try once more before giving up.
    for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages,
            cache_control: { type: 'ephemeral' }, // reuse the unchanged earlier part of the journey
            output_config: {
                format: { type: 'json_schema', schema: STORY_SCHEMA }
            }
        });

        logUsage(response.usage);

        if (response.stop_reason === 'refusal') {
            console.error('Model declined the request:', JSON.stringify(response.stop_details));
            throw new StoryError('The storyteller declined to continue this thread. Please try a different choice.');
        }

        // The reply is a list of blocks (thinking, text, ...). Use the text ones.
        const text = (response.content || [])
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('')
            .trim();

        const story = normalizeStory(text ? extractJson(text) : null);
        if (story) return story;

        lastProblem = !text
            ? 'no text block in response'
            : 'text was not a valid story (narrative, 4 choices, metadata)';
        console.error(`Story parse failed (attempt ${attempt}/2): ${lastProblem}`);
        console.error('  model:', response.model, '| stop_reason:', response.stop_reason,
            '| block types:', (response.content || []).map(b => b.type).join(', ') || 'none');
        console.error('  text received:', text ? text.slice(0, 2000) : '(empty)');
    }

    throw new StoryError('The storyteller returned a response the game could not read. Please try again.');
}

// One line per request, so the cost of play can be followed in the host's logs.
function logUsage(usage) {
    if (!usage) return;
    console.log(`Claude usage - new input: ${usage.input_tokens}, reused input: ${usage.cache_read_input_tokens || 0}, ` +
        `stored for reuse: ${usage.cache_creation_input_tokens || 0}, output: ${usage.output_tokens}`);
}

// ===== ERRORS =====

// Turn any failure into a clear log line and a clear JSON error for the browser.
function sendError(res, error, where) {
    if (error instanceof StoryError) {
        console.error(`${where}: ${error.message}`);
        return res.status(error.status).json({ error: error.message });
    }

    if (error instanceof Anthropic.APIError) {
        console.error(`${where}: Claude API error (status ${error.status}, model ${MODEL}):`, error.message);
        let message = 'The story service had a problem. Please try again in a moment.';
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
            message = 'The story service is not configured correctly (API key problem).';
        } else if (error instanceof Anthropic.NotFoundError) {
            message = `The story service is not configured correctly (model "${MODEL}" not found).`;
        } else if (error instanceof Anthropic.RateLimitError) {
            message = 'The story service is busy right now. Please wait a moment and try again.';
        } else if (error instanceof Anthropic.APIConnectionTimeoutError) {
            message = 'The storyteller took too long to answer. Please try again.';
        } else if (error instanceof Anthropic.APIConnectionError) {
            message = 'Could not reach the story service. Please try again in a moment.';
        }
        return res.status(502).json({ error: message });
    }

    console.error(`${where}:`, error);
    return res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
}

// ===== REBUILDING THE CONVERSATION =====

// Rebuild the conversation for Claude from the journey the browser sent:
// the opening story plus each { choice, story } turn since. Throws a
// StoryError (400) if the data is not a well-formed journey.
function buildMessages(opening, turns) {
    const bad = () => new StoryError('The saved journey could not be read. Please reload the page or load a save.', 400);

    const firstStory = normalizeStory(opening, false);
    if (!firstStory || !Array.isArray(turns) || turns.length > MAX_TURNS) throw bad();

    const cleanTurns = turns.map(turn => {
        const story = normalizeStory(turn && turn.story, false);
        if (!story || !validChoice(turn.choice)) throw bad();
        return { choice: turn.choice, choiceIndex: turn.choiceIndex, story };
    });

    const messages = [
        { role: 'user', content: START_PROMPT },
        { role: 'assistant', content: JSON.stringify(firstStory) }
    ];

    // How many of the oldest turns to condense (0 for all but very long journeys).
    const condensed = Math.max(0, Math.floor((cleanTurns.length - RECENT_TURNS_IN_FULL) / CONDENSE_STEP) * CONDENSE_STEP);

    let digest = '';
    if (condensed > 0) {
        const lines = cleanTurns.slice(0, condensed).map((turn, i) =>
            `${i + 1}. Chose "${turn.choice.trim()}" - arrived at: ${turn.story.metadata.location} (${turn.story.metadata.dreamState})`);
        digest = '[Summary of the journey between the opening and now, one line per step:\n' +
            lines.join('\n') +
            '\nThe story continues in full from here.]\n\n';
    }

    cleanTurns.slice(condensed).forEach((turn, i) => {
        messages.push(
            { role: 'user', content: (i === 0 ? digest : '') + choiceMessage(turn.choice, turn.choiceIndex) },
            { role: 'assistant', content: JSON.stringify(turn.story) }
        );
    });

    return messages;
}

function validChoice(choice) {
    return typeof choice === 'string' && choice.trim() !== '' && choice.length <= MAX_CHOICE_CHARS;
}

function choiceMessage(choice, choiceIndex) {
    const optionNumber = Number.isInteger(choiceIndex) && choiceIndex >= 0 && choiceIndex < CHOICES_PER_STORY
        ? ` (option ${choiceIndex + 1})`
        : '';
    return `The player chose: "${choice.trim()}"${optionNumber}. Continue the story based on this choice.`;
}

// ===== ROUTES =====

// The link-preview picture used to be a much larger PNG; older shared links
// may still ask for it.
app.get('/og-image.png', (req, res) => res.redirect(301, '/og-image.jpg'));

// Used by the host to check the server is up.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Start a new game.
app.post('/api/start', rateLimit, async (req, res) => {
    try {
        let story;
        try {
            story = await generateStory([{ role: 'user', content: START_PROMPT }]);
        } catch (error) {
            // If Claude answered but the answer was unusable, fall back to the
            // built-in opening so the game can still begin. Real API failures
            // (bad key, bad model, outage) are reported instead.
            if (!(error instanceof StoryError)) throw error;
            console.error('Using built-in opening narrative as fallback.');
            story = OPENING_NARRATIVE;
        }

        res.json({ story });
    } catch (error) {
        sendError(res, error, 'Error starting game');
    }
});

// Continue story. The browser sends the journey so far and the new choice.
app.post('/api/continue', rateLimit, async (req, res) => {
    try {
        const { opening, turns, choice, choiceIndex } = req.body || {};

        if (!opening) {
            // A page loaded before the save system was rebuilt sends the old
            // request format. Its autosave is converted when the page reloads.
            return res.status(400).json({ error: 'The game has been updated. Please refresh the page, then choose Continue Journey.' });
        }
        if (!validChoice(choice)) {
            return res.status(400).json({ error: 'No choice was provided.' });
        }

        const messages = buildMessages(opening, turns || []);
        messages.push({ role: 'user', content: choiceMessage(choice, choiceIndex) });

        res.json({ story: await generateStory(messages) });
    } catch (error) {
        sendError(res, error, 'Error continuing story');
    }
});

// Compatibility only: pages loaded before the save system was rebuilt call
// this when continuing a journey, and delete their autosave if it fails.
// Answering keeps that autosave safe until the page is refreshed.
app.post('/api/restore', (req, res) => {
    const sessionData = (req.body && req.body.sessionData) || {};
    res.json({ story: sessionData.currentState || {}, message: 'Session restored successfully' });
});

// Report malformed or oversized requests as JSON rather than an HTML page.
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const tooLarge = error && error.type === 'entity.too.large';
    console.error('Request error:', error && error.message);
    res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'This journey has grown too large to send.' : 'The request could not be read.'
    });
});

app.listen(PORT, () => {
    console.log(`WuTong Mountain server running on port ${PORT} (model: ${MODEL})`);
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('WARNING: ANTHROPIC_API_KEY is not set - story requests will fail.');
    }
});
