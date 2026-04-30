# Time Table Generator

Web app for generating class and staff timetables.

## Features

- 3 years with 2 sections each
- 6-day order `A-F`
- 5 sessions per day
- 55-minute class periods
- Staff max load check (`18` hours)
- Student timetable view
- Staff timetable view
- Firestore cloud save/load
- Netlify-ready Vite build

## Local run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Firebase setup

1. Create Firebase project.
2. Enable Firestore Database.
3. Copy `.env.example` to `.env`.
4. Fill Vite Firebase variables.
5. Optional: deploy Firestore rules with `firebase deploy --only firestore`.

Firestore document used:

- Collection: `timetables`
- Document: `main`

## Netlify setup

1. Push repo to GitHub.
2. Import repo in Netlify.
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Add same Firebase env vars in Netlify project settings.

`netlify.toml` already included.

## GitHub repo

Recommended repo name:

- `time-table-generator`

If GitHub CLI is installed locally:

```bash
git init
git add .
git commit -m "feat: add timetable generator web app"
gh repo create time-table-generator --public --source . --remote origin --push
```
