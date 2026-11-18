# WuTong Mountain | 梧桐山

An interactive narrative told by Claude. You play Nameless, a dream doctor who
descends from a cave on WuTong Mountain to heal the nightmares of a utopian
world. Live at [wutongmountain.org](https://www.wutongmountain.org).

## How it is put together

| Part | File | What it does |
| --- | --- | --- |
| Server | `server.js` | Serves the page and asks Claude for each story segment |
| Storyteller | `src/storyEngine.js` | The instructions given to Claude, and the built-in opening scene |
| Page | `public/index.html`, `public/style.css` | What the player sees |
| Game | `public/script.js` | Play, the journal, saving and loading, exports |

The server keeps no game state. The browser holds the whole journey and sends
it with each choice, so restarting or redeploying the server never loses a
game. Saves live in the player's browser and can be downloaded as files.

## Running it on your own computer

You need [Node.js](https://nodejs.org) 22 or newer.

1. Create a file named `.env` in this folder containing your Anthropic API key:

   ```
   ANTHROPIC_API_KEY=your-key-here
   ```

2. In a terminal opened in this folder:

   ```
   npm install
   npm start
   ```

3. Open <http://localhost:3000>.

`npm run dev` does the same but restarts the server whenever a file changes.

## Settings

Set these in `.env` locally, or as variables on the host (Railway).

| Variable | Required | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | The key used to call Claude |
| `CLAUDE_MODEL` | no | Which Claude model tells the story. Defaults to `claude-opus-5-5` |
| `PORT` | no | The port to listen on. Defaults to `3000`; Railway sets this itself |

## Deploying

The site runs on Railway and redeploys automatically whenever the `main`
branch on GitHub changes.

## License

MIT - see `LICENSE`.
