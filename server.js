require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const { SYSTEM_PROMPT, createInitialStory } = require('./src/storyEngine');

const app = express();
const port = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store conversation history in memory (in production, use a database)
const conversations = new Map();

app.post('/api/start', (req, res) => {
  const sessionId = Date.now().toString();
  const initialStory = createInitialStory();
  
  conversations.set(sessionId, {
    history: [],
    currentState: initialStory,
    choices: [],
    timestamp: new Date().toISOString()
  });
  
  res.json({
    sessionId,
    story: initialStory
  });
});

app.post('/api/continue', async (req, res) => {
  try {
    const { sessionId, choice, choiceIndex } = req.body;
    
    if (!conversations.has(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const session = conversations.get(sessionId);
    
    // Build conversation history for Claude
    const messages = session.history.concat([
      {
        role: 'user',
        content: `The player chose: "${choice}"\n\nGenerate the next story segment with 4 new choices. Return ONLY valid JSON matching the specified format.`
      }
    ]);
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: messages
    });
    
    const content = response.content[0].text;
    
    // Parse Claude's JSON response
    let storyData;
    try {
      storyData = JSON.parse(content);
    } catch (parseError) {
      // If Claude didn't return pure JSON, try to extract it
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        storyData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not parse story data');
      }
    }
    
    // Update conversation history
    session.history.push(
      {
        role: 'user',
        content: `Player chose: "${choice}"`
      },
      {
        role: 'assistant',
        content: content
      }
    );
    
    // Track choices made
    session.choices.push({
      choice,
      choiceIndex,
      timestamp: new Date().toISOString()
    });
    
    session.currentState = storyData;
    session.timestamp = new Date().toISOString();
    
    res.json({ story: storyData });
    
  } catch (error) {
    console.error('Error generating story:', error);
    res.status(500).json({ 
      error: 'Failed to generate story',
      details: error.message 
    });
  }
});

// New endpoint: Get session state for loading
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (!conversations.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const session = conversations.get(sessionId);
  res.json({
    sessionId,
    story: session.currentState,
    choiceHistory: session.choices,
    timestamp: session.timestamp
  });
});

// New endpoint: Restore session from saved data
app.post('/api/restore', (req, res) => {
  const { sessionId, sessionData } = req.body;
  
  // Restore the session to memory
  conversations.set(sessionId, sessionData);
  
  res.json({
    success: true,
    story: sessionData.currentState
  });
});

app.listen(port, () => {
  console.log(`WuTong Mountain server listening at http://localhost:${port}`);
});