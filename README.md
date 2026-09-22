# Quiz Battle Arena

A 2–4 player real-time multiplayer quiz game built with Vite + Firebase Realtime Database and deployable to Vercel.

## Rules
- Create or join a 4-character room code.
- Minimum 2 and maximum 4 players.
- 10 questions per player.
- Correct answer = 1 point.
- Highest score after question 10 wins.

## Firebase setup
1. Create a Firebase project.
2. Enable Realtime Database.
3. Add a Web App and copy its config into `.env.local` using `.env.example`.
4. For a challenge demo, configure Realtime Database rules appropriate to your project. For production, add authentication and validate writes server-side.

## Run
npm install
npm run dev

## Build
npm run build

## Vercel
Import the repository into Vercel, add the seven `VITE_FIREBASE_*` environment variables, and deploy. Vercel detects Vite automatically.
