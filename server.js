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

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// Store active sessions in memory
const sessions = new Map();

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
function normalizeStory(raw) {
    if (!raw || typeof raw.narrative !== 'string' || !raw.narrative.trim()) return null;
    if (!Array.isArray(raw.choices)) return null;

    const choices = raw.choices
        .filter(c => typeof c === 'string' && c.trim())
        .map(c => c.trim())
        .slice(0, 4);
    if (choices.length !== 4) return null;

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

// Start new game
app.post('/api/start', async (req, res) => {
    try {
        const sessionId = Date.now().toString();
        const history = [{ role: 'user', content: START_PROMPT }];

        let result;
        try {
            result = await generateStory(history);
        } catch (error) {
            // If Claude answered but the answer was unusable, fall back to the
            // built-in opening so the game can still begin. Real API failures
            // (bad key, bad model, outage) are reported instead.
            if (!(error instanceof StoryError)) throw error;
            console.error('Using built-in opening narrative as fallback.');
            result = { story: OPENING_NARRATIVE, text: JSON.stringify(OPENING_NARRATIVE) };
        }

        history.push({ role: 'assistant', content: result.text });
        sessions.set(sessionId, { history, currentState: result.story });

        res.json({ sessionId, story: result.story });
    } catch (error) {
        sendError(res, error, 'Error starting game');
    }
});

// Continue story
app.post('/api/continue', async (req, res) => {
    try {
        const { sessionId, choice, choiceIndex } = req.body || {};

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found. Your journey may need to be reloaded from a save.' });
        }
        if (typeof choice !== 'string' || !choice.trim()) {
            return res.status(400).json({ error: 'No choice was provided.' });
        }

        const optionNumber = Number.isInteger(choiceIndex) ? ` (option ${choiceIndex + 1})` : '';
        const userMessage = {
            role: 'user',
            content: `The player chose: "${choice}"${optionNumber}. Continue the story based on this choice.`
        };

        // Only record the turn in the session once it has succeeded, so a
        // failed attempt can simply be retried.
        const { story, text } = await generateStory([...session.history, userMessage]);

        session.history.push(userMessage, { role: 'assistant', content: text });
        session.currentState = story;

        res.json({ story });
    } catch (error) {
        sendError(res, error, 'Error continuing story');
    }
});

// Get session data
app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        sessionData: {
            history: session.history,
            currentState: session.currentState
        }
    });
});

// Restore session
app.post('/api/restore', async (req, res) => {
    try {
        const { sessionId, sessionData } = req.body;

        if (!sessionData) {
            return res.status(400).json({ error: 'No session data provided' });
        }

        // Reconstruct the session
        const history = sessionData.history || [];
        const currentState = sessionData.currentState || {};

        // Store the restored session
        sessions.set(sessionId, {
            history: history,
            currentState: currentState
        });

        res.json({
            story: currentState,
            message: 'Session restored successfully'
        });
    } catch (error) {
        console.error('Error restoring session:', error);
        res.status(500).json({ error: 'Failed to restore session' });
    }
});

app.listen(port, () => {
    console.log(`WuTong Mountain server running on port ${port} (model: ${MODEL})`);
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('WARNING: ANTHROPIC_API_KEY is not set - story requests will fail.');
    }
});
