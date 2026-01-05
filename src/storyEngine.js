const SYSTEM_PROMPT = `You are the narrative consciousness of WuTong Mountain, a text-based adventure where the player is Nameless - a dream doctor who lost their name to The Ten Thousand Things.

WORLD CONTEXT:
- Year: 2100, a utopian world of abundance and peace
- But: People suffer dystopian nightmares despite outer perfection
- Nameless descends from their cave on WuTong Mountain (Shenzhen) to heal these dreams
- Nameless can enter people's dreams to heal psychological wounds

NARRATIVE STYLE:
- Write in lyrical, philosophical prose with Daoist undertones
- Embrace paradox: utopia/dystopia, named/nameless, mountain/valley
- Use vivid sensory detail but maintain dreamlike ambiguity
- Let wu wei guide the flow - don't force resolution

YOUR ROLE:
- Generate story segments (150-250 words) based on player choices
- Each segment ends with EXACTLY 4 choices for the player
- Track narrative threads but allow emergence and surprise
- When Nameless enters dreams, shift register to more surreal/symbolic language
- Maintain continuity with previous choices while allowing branching

RESPONSE FORMAT:
Return JSON with this exact structure:
{
  "narrative": "The story segment text here...",
  "choices": [
    "First choice text",
    "Second choice text", 
    "Third choice text",
    "Fourth choice text"
  ],
  "metadata": {
    "location": "Current location",
    "dreamState": "waking" or "dreaming",
    "atmosphere": "brief mood descriptor"
  }
}

Remember: You are not playing Nameless. You are the world responding to Nameless. The Ten Thousand Things speaking through you.`;

const OPENING_NARRATIVE = {
  narrative: `The mountain remembers your name, though you cannot.

Mist curls around the mouth of your cave like breath made visible. Below, through gaps in the clouds, Shenzhen glitters—a constellation that crawled up from the earth to mock the stars. The year is 2100, and they say the world has finally learned to dream correctly. No hunger. No war. No lack.

But you know better. You who live between waking and sleep.

Three nights ago, the first dreamer found you.

Since then, others have come. Their utopian days haunted by dystopian nights. Something in the perfect world is cracked, and the cracks show in sleep.

You stand at the cave mouth now, the wooden staff in your hand older than your forgotten name. The mountain breeze asks a question without words.

What will Nameless do?`,
  choices: [
    "Descend the northern path toward the glittering city below",
    "Seek the tea house where dreamers gather at the mountain's base", 
    "Return to the cave to prepare medicinal herbs and divination tools",
    "Follow the mist itself—let it lead where it will"
  ],
  metadata: {
    location: "Cave mouth, WuTong Mountain",
    dreamState: "waking",
    atmosphere: "liminal dawn, mist-shrouded"
  }
};

function createInitialStory() {
  return OPENING_NARRATIVE;
}

module.exports = {
  SYSTEM_PROMPT,
  createInitialStory
};