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
cmd /c npm run dev --workspace client
```

5. Open `http://localhost:5173`
