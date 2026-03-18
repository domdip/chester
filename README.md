# Separation Anxiety Training App

A static web app for running daily separation training ladders inspired by Julie Naismith-style sub-threshold protocols, with Firebase cloud sync.

## What It Does

- Builds a daily plan with a configurable number of sessions:
  - Random warmups (much shorter than the long target)
  - 1 long target session
- Runs a timer and logs outcomes for each step
- Recovers an in-progress or just-finished timer after offline periods, reloads, or mobile tab eviction
- Long-target outcomes use 3 choices: thumbs up, middle, thumbs down
- If the long target is thumbs up, the next day's long target increases by your configured percentage
- If the long target is middle, the next day's long target stays the same as the current long target
- If the long target is thumbs down, behavior is configurable:
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

## Testing

- Run the full suite with `npm test`.
- Run only unit tests with `npm run test:unit`.
- Run the browser smoke test with `npm run test:e2e`.

The browser smoke test serves the app locally and stubs Firebase/Chart CDN modules so it can run offline without touching your real backend.

## Deploy

Deploy as a static site to GitHub Pages, Cloudflare Pages, or Netlify.

## GitHub Pages Prod + Staging

This repo is set up to publish both environments to the `gh-pages` branch through GitHub Actions:

- `main` deploys production to the site root
- `staging` deploys staging to `/staging/`

For a repo named `sep`, the URLs will be:

- Production: `https://<your-github-user>.github.io/sep/`
- Staging: `https://<your-github-user>.github.io/sep/staging/`

### One-Time Setup

1. In GitHub, open `Settings -> Pages`.
2. Set the source to `Deploy from a branch`.
3. Choose branch `gh-pages` and folder `/ (root)`.
4. Commit real staging Firebase values into [firebase-config.staging.js](/home/ddd/ws/sep/firebase-config.staging.js).
5. In Firebase Authentication, add both your production Pages URL and your staging `/staging/` URL to Authorized domains or redirect allowlists as needed.

### Daily Workflow

1. Push to `main` to update production.
2. Push to `staging` to update staging.
3. Test staging on phone by opening the `/staging/` URL, starting a timer, backgrounding the browser, toggling offline mode, and reopening the page.

### Notes

- Keep production and staging on separate Firebase projects.
- The staging deploy reuses the same app files, but swaps in `firebase-config.staging.js` as `firebase-config.js` at publish time.
- Both environments live in the same Pages site, so a staging deploy will not overwrite production.

## Notes

- Keep sessions below panic threshold.
- Firebase web config values are safe to expose in frontend apps.
- This app is a companion tracker, not veterinary or behavioral medical advice.

## Multiple Ladders Per Day

- You can run more than one ladder per day.
- After completing a ladder, the app shows a completion message and a `Start New Session` button.
- Use `Start New Session` to generate a fresh set of warmups + 1 long target.
- The new ladder uses your current `nextLongTarget` (including any changes from previous long-session outcomes).
