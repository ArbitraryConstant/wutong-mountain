require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, OPENING_NARRATIVE } = require('./src/storyEngine');

const app = express();
const port = process.env.PORT || 3000;

// Default model; set CLAUDE_MODEL in the environment (e.g. on Railway) to override.
const MODEL = (process.env.CLAUDE_MODEL || '').trim() || 'claude-opus-5-5';

// Current models think before answering, and that thinking counts against
// max_tokens, so this needs plenty of headroom beyond the story itself.
const MAX_TOKENS = 16000;

const START_PROMPT = 'Begin the story with the opening narrative and provide the first set of choices.';

// Limits on what the browser may send as "the journey so far".
const MAX_TURNS = 2000;
const MAX_NARRATIVE_CHARS = 20000;
const MAX_CHOICE_CHARS = 1000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// The server keeps no game state. The browser holds the whole journey and
// sends it with each choice, so restarts and redeploys cannot lose a game.

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
        .slice(0, 4);
    if (requireFourChoices && choices.length !== 4) return null;

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

// Ask Claude for the next story segment. Returns { story, text } or throws.
async function generateStory(messages) {
    let lastProblem = 'unknown';

    // If the reply can't be used, try once more before giving up.
    for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages,
            output_config: {
                format: { type: 'json_schema', schema: STORY_SCHEMA }
            }
        });

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
        if (story) return { story, text: JSON.stringify(story) };

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
        } else if (error instanceof Anthropic.APIConnectionError) {
            message = 'Could not reach the story service. Please try again in a moment.';
        }
        return res.status(502).json({ error: message });
    }

    console.error(`${where}:`, error);
    return res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
}

// Rebuild the conversation for Claude from the journey the browser sent:
// the opening story plus each { choice, story } turn since. Throws a
// StoryError (400) if the data is not a well-formed journey.
function buildMessages(opening, turns) {
    const bad = () => new StoryError('The saved journey could not be read. Please reload the page or load a save.', 400);

    const firstStory = normalizeStory(opening, false);
    if (!firstStory || !Array.isArray(turns) || turns.length > MAX_TURNS) throw bad();

    const messages = [
        { role: 'user', content: START_PROMPT },
        { role: 'assistant', content: JSON.stringify(firstStory) }
    ];

    for (const turn of turns) {
        const story = normalizeStory(turn && turn.story, false);
        if (!story || !validChoice(turn.choice)) throw bad();
        messages.push(
            { role: 'user', content: choiceMessage(turn.choice, turn.choiceIndex) },
            { role: 'assistant', content: JSON.stringify(story) }
        );
    }

    return messages;
}

function validChoice(choice) {
    return typeof choice === 'string' && choice.trim() !== '' && choice.length <= MAX_CHOICE_CHARS;
}

function choiceMessage(choice, choiceIndex) {
    const optionNumber = Number.isInteger(choiceIndex) && choiceIndex >= 0 && choiceIndex < 4
        ? ` (option ${choiceIndex + 1})`
        : '';
    return `The player chose: "${choice.trim()}"${optionNumber}. Continue the story based on this choice.`;
}

// Start new game
app.post('/api/start', async (req, res) => {
    try {
        let story;
        try {
            ({ story } = await generateStory([{ role: 'user', content: START_PROMPT }]));
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
app.post('/api/continue', async (req, res) => {
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

        const { story } = await generateStory(messages);
        res.json({ story });
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

app.listen(port, () => {
    console.log(`WuTong Mountain server running on port ${port} (model: ${MODEL})`);
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('WARNING: ANTHROPIC_API_KEY is not set - story requests will fail.');
    }
});
