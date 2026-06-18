# Secret Hitler Online

A real-time multiplayer Secret Hitler game built with Node.js, Express, and WebSockets.

## Features

- **Full game implementation** — roles, voting, policies, executive powers, veto, win conditions
- **Bot players** — AI bots with role-aware intelligence that vote, legislate, lie, and chat
- **Live chat** — in-game chat with emote support
- **7TV emotes** — global 7TV emotes loaded automatically, plus import custom emotes/sets/users via link
- **Emote picker** — searchable picker with built-in emoji and 7TV emotes
- **Claim system** — president/chancellor can claim what cards they drew/received
- **Game mat UI** — horizontal policy boards with card art, draw/discard piles, election tracker
- **Player cards** — role card display with icons for president, chancellor, nominee, etc.
- **Draggable panels** — log, chat, and notes panels can be reordered and collapsed
- **Resizable layout** — drag the divider between game board and chat panels
- **Log filtering** — filter game log by claims, votes, policies, or kills
- **Name colors** — pick a custom color for your name across chat and player cards
- **Dark/light theme** — toggle between themes
- **Timed mode** — optional auto-action timer for each phase
- **Reconnection** — auto-reconnect on disconnect, rejoin your game
- **Game history** — local win/loss tracking with stats

## Setup

```bash
npm install
npm start
```

Server runs on port `3000` by default (or `PORT` env variable).

Open `http://localhost:3000` in your browser.

## Deployment

### Railway

Already configured via `railway.json`. Push to Railway and it deploys automatically.

### Render

Already configured via `render.yaml`. Connect your repo to Render.

### Manual

```bash
node server.js
```

Requires Node.js 18+.

## Project Structure

```
secret-hitler/
├── server.js              # Game server (Express + WebSocket)
├── package.json
├── public/
│   ├── index.html         # Entire client (HTML + CSS + JS)
│   ├── card-liberal.svg   # Liberal policy card art
│   └── card-fascist.svg   # Fascist policy card art
├── railway.json           # Railway deployment config
└── render.yaml            # Render deployment config
```

## How to Play

1. **Create** a game and share the 4-letter room code
2. **Join** with the room code — supports 5-10 players (fill remaining slots with bots)
3. **Roles** are assigned secretly — Liberals, Fascists, and Hitler
4. Each round: President nominates a Chancellor, everyone votes, then policies are enacted
5. **Liberals win** by enacting 5 Liberal policies or executing Hitler
6. **Fascists win** by enacting 6 Fascist policies or electing Hitler as Chancellor after 3 Fascist policies

## Bot AI

Bots play with role-aware strategy:

- **Liberal bots** — pass liberal policies, vote against suspicious players, investigate and execute suspected fascists
- **Fascist bots** — subtly pass fascist policies, support teammates, deflect blame onto liberals
- **Hitler bot** — plays like a cautious liberal to avoid detection

Bots also chat, make claims, accuse other players, and lie about their cards.

## License

MIT
