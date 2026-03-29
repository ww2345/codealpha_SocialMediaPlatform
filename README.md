# SocialGram

## Project Description
SocialGram is a full‑stack social app MVP where users can create accounts, find other users, send/accept friend requests, and chat with friends in real time.

What you can do today:
- Register / login (JWT auth)
- Search users by username
- Send, accept, and decline friend requests
- View your friends list
- Real‑time 1:1 chat via Socket.IO

**Important**
- MongoDB database (default): `socialgram` (from `MONGO_URI`)
- Collections: `users`, `friendrequests`, `messages`
- Backend env: `backend/.env.example` → `backend/.env`
- Frontend env: `.env.example` → `frontend/.env`
- The backend can serve the built frontend in production, so Render can run this as one web service
- Uploaded images live on the server filesystem unless you attach a Render disk or use cloud storage

## Tech Stack
- **Backend:** Node.js, Express, MongoDB, Mongoose, Socket.IO, JWT, bcrypt
- **Frontend:** React (Vite), React Router, Axios, socket.io-client, plain CSS (neon theme)

## Quickstart (Local)
Prereqs: Node.js + npm, MongoDB running locally (or a MongoDB URI).

1) Backend
- `cd backend`
- `cp .env.example .env` (set `MONGO_URI`, `JWT_SECRET`, `CLIENT_URL` as needed)
- `npm install`
- `npm run dev` (defaults to `http://localhost:4000`)

2) Frontend
- `cd frontend`
- Create `frontend/.env` (you can start from the repo’s `.env.example`):
  - `cp ../.env.example .env`
- `npm install`
- `npm run dev` (defaults to `http://localhost:5173`)

## Render Deployment
This repo is set up for the simplest Render flow: one Node web service that serves both the API and the built React app.

1. Create a MongoDB Atlas cluster, database user, and connection string.
2. Push the repo to GitHub.
3. In Render, create a new Blueprint from this repo so it reads `render.yaml`.
4. Set your Render environment variables:
   - `MONGO_URI`: your MongoDB Atlas URI
   - `JWT_SECRET`: a long random secret
   - `CLIENT_URL`: optional; only needed if you split frontend and backend onto different domains
   - `UPLOAD_DIR`: optional; change this to your Render disk mount path if you add persistent storage
5. Deploy. Render will install both apps, build the Vite frontend, and start Express on the backend service.

Health check endpoint: `GET /health`

### Upload persistence
SocialGram currently stores uploaded images on the local filesystem. On Render, those files are ephemeral unless you attach a persistent disk.

If you want uploads to survive redeploys, do one of these:
- attach a Render disk and set `UPLOAD_DIR` to the disk mount path
- move media storage to a service like Cloudinary or S3

## API Documentation
Base URL (dev): `http://localhost:4000`  
Content type: JSON  
Auth header (protected routes): `Authorization: Bearer <JWT>`

### Auth
**POST** `/api/auth/register`  
Body:
```json
{ "username": "alice", "email": "alice@example.com", "password": "secret" }
```
Response:
```json
{ "token": "…", "user": { "id": "…", "username": "alice", "email": "alice@example.com" } }
```

**POST** `/api/auth/login`  
Body:
```json
{ "email": "alice@example.com", "password": "secret" }
```
Response:
```json
{ "token": "…", "user": { "id": "…", "username": "alice" } }
```

### Users (Protected)
**GET** `/api/users/me`  
Returns the current user (excluding `passwordHash`) and populates `friends` with `username` and `avatarUrl`.

**GET** `/api/users/search?q=<username>`  
Searches users by `username` (case‑insensitive). Returns up to 20 results with `username`, `avatarUrl`, and `bio`.

### Friend Requests (Protected)
**POST** `/api/requests/send`  
Body:
```json
{ "toUserId": "…" }
```
Creates a friend request from the current user to `toUserId` (unique per pair).

**GET** `/api/requests`  
Returns:
```json
{ "incoming": [/* pending requests to me */], "outgoing": [/* pending requests from me */] }
```

**POST** `/api/requests/:id/accept`  
Accepts a request (must be the `to` user). Adds each user to the other’s `friends` list.

**POST** `/api/requests/:id/decline`  
Declines a request (must be the `to` user).

### Messages (Protected)
**GET** `/api/messages/:conversationId`  
Returns up to 200 messages for the conversation (sorted by `createdAt` ascending).

**Conversation IDs**
- The frontend builds a stable 1:1 conversation id as: `<userIdA>_<userIdB>` where ids are sorted lexicographically.

### Socket.IO (Real‑time Chat)
Socket server: same origin as the backend (example: `http://localhost:4000`)

Auth: pass the JWT during the handshake:
```js
io(API_URL, { auth: { token } })
```

Events:
- Client → Server: `joinConversation(conversationId)`
- Client → Server: `sendMessage({ conversationId, to, text })`
- Server → Room: `message` (sends the saved message document)
- Server → Recipient socket (if online): `new_message_notification({ from, conversationId })`

## Project Structure
- `backend/server.js` — Express API + Socket.IO server
- `backend/models/*` — Mongoose models (`User`, `FriendRequest`, `Message`)
- `frontend/src/*` — React UI (Auth, Search, Requests, Friends, Chat)
