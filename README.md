# Separation Anxiety Training App

A static web app for running daily separation training ladders inspired by Julie Naismith-style sub-threshold protocols, with Firebase cloud sync.

## What It Does

- Builds a daily plan with a configurable number of sessions:
  - Random warmups (much shorter than the long target)
  - 1 long target session
- Runs a timer and logs each session as calm success or stress signal
- If the long target is successful, the next day's long target increases by your configured percentage
- If the long target fails, behavior is configurable:
  - Reduce next target by a configured percentage
  - Retry the same target tomorrow
- Syncs state with Firebase so your data is available on phone and desktop

## Firebase Setup

1. Create a Firebase project in the Firebase console.
2. Enable Authentication -> Sign-in method -> Google.
3. Create a Firestore database (Production or Test mode).
4. In Firestore Rules, allow users to read/write only their own document path:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

5. Open [firebase-config.js](/home/ddd/ws/sep/firebase-config.js) and fill in your web app config values.
6. In Authentication -> Settings -> Authorized domains, add your deployed site domain.

## Run Locally

1. Serve the folder with any static server (or open through your hosting preview).
2. Open the app in browser.
3. Click `Sign in with Google`.
4. Confirm the cloud badge shows `Cloud sync active`.

## Deploy

Deploy as a static site to GitHub Pages, Cloudflare Pages, or Netlify.

## Notes

- Keep sessions below panic threshold.
- Firebase web config values are safe to expose in frontend apps.
- This app is a companion tracker, not veterinary or behavioral medical advice.

## Multiple Ladders Per Day

- You can run more than one ladder per day.
- After completing a ladder, the app shows a completion message and a `Start New Session` button.
- Use `Start New Session` to generate a fresh set of warmups + 1 long target.
- The new ladder uses your current `nextLongTarget` (including any changes from previous long-session outcomes).
