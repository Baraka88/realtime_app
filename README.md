# Real-Time Application

Full-stack starter using:

- Node.js
- Express
- Socket.IO
- MySQL
- React + Vite

## Run locally

1. Install dependencies:

```bash
cmd /c npm install --workspaces
```

2. Create `server/.env` from `server/.env.example`.
   The server will create the MySQL database and `messages` table automatically on startup.

3. Start backend:

```bash
cmd /c npm run dev --workspace server
```

4. In a second terminal, start frontend:

```bash
npm run dev --workspace client
```

5. Open `http://localhost:5173`

## Deployment note

This repository contains:

- `client/`: a static React app that can be deployed to hosts like Cloudflare Pages
- `server/`: a Node.js + Express + Socket.IO + MySQL backend that needs a server runtime

If you deploy with Cloudflare Pages, use:

- Build command: `npm run build`
- Output directory: `client/dist`

Cloudflare Pages will only host the frontend. The backend should be deployed separately to a Node-compatible platform such as Render, Railway, Fly.io, or a VPS.
