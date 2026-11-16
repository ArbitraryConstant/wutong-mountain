require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, OPENING_NARRATIVE } = require('./src/storyEngine');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// Store active sessions in memory
const sessions = new Map();

// Start new game
app.post('/api/start', async (req, res) => {
    try {
        const sessionId = Date.now().toString();
        
        const response = await anthropic.messages.create({
            model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
            max_tokens: 2000,
            system: SYSTEM_PROMPT,
            messages: [
                {
                    role: 'user',
                    content: 'Begin the story with the opening narrative and provide the first set of choices.'
                }
            ]
        });

        const content = response.content[0].text;
        
        let story;
        try {
            const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/({[\s\S]*})/);
            if (jsonMatch) {
                story = JSON.parse(jsonMatch[1]);
            } else {
                story = JSON.parse(content);
            }
        } catch (parseError) {
            console.error('Parse error:', parseError);
            story = {
                narrative: OPENING_NARRATIVE,
                choices: [
                    "Consult the bone pattern first, reading the dreamer's deeper truth",
                    "Descend immediately to the glass tower, speed over preparation",
                    "Meditate at the cave mouth, centering yourself before action",
                    "Ask the mountain's ancient spirits for guidance"
                ],
                metadata: {
                    location: "WuTong Mountain Cave",
                    dreamState: "waking",
                    atmosphere: "contemplative dawn"
                }
            };
        }

        const conversationHistory = [
            {
                role: 'user',
                content: 'Begin the story with the opening narrative and provide the first set of choices.'
            },
            {
                role: 'assistant',
                content: content
            }
        ];

        sessions.set(sessionId, {
            history: conversationHistory,
            currentState: story
        });

        res.json({ sessionId, story });
    } catch (error) {
        console.error('Error starting game:', error);
        res.status(500).json({ error: 'Failed to start game' });
    }
});

// Continue story
app.post('/api/continue', async (req, res) => {
    try {
        const { sessionId, choice, choiceIndex } = req.body;
        
        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const userMessage = {
            role: 'user',
            content: `The player chose: "${choice}" (option ${choiceIndex + 1}). Continue the story based on this choice.`
        };

        session.history.push(userMessage);

        const response = await anthropic.messages.create({
            model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
            max_tokens: 2000,
            system: SYSTEM_PROMPT,
            messages: session.history
        });

        const content = response.content[0].text;
        
        let story;
        try {
            const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/({[\s\S]*})/);
            if (jsonMatch) {
                story = JSON.parse(jsonMatch[1]);
            } else {
                story = JSON.parse(content);
            }
        } catch (parseError) {
            console.error('Parse error on continue:', parseError);
            console.error('Content received:', content);
            return res.status(500).json({ error: 'Failed to parse story response' });
        }

        const assistantMessage = {
            role: 'assistant',
            content: content
        };

        session.history.push(assistantMessage);
        session.currentState = story;

        res.json({ story });
    } catch (error) {
        console.error('Error continuing story:', error);
        res.status(500).json({ error: 'Failed to continue story' });
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
    console.log(`WuTong Mountain server running on port ${port}`);
});
