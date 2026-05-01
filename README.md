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
- Reserved class slots and reserved staff slots
- Cloud save/load with version history restore
- Timetable dirty-state warning after planning edits
- Lock/pin timetable cells and manual lock editor
- Inline edit for teaching loads and reserved classes
- Constraint toggles (first/last hour, same-subject/day, max consecutive)
- Room support and room heatmap
- Role modes (admin/editor/viewer) and finalize-date lock
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
3. Enable Authentication -> Anonymous sign-in.
3. Copy `.env.example` to `.env`.
4. Fill Vite Firebase variables.
5. Optional: deploy Firestore rules with `firebase deploy --only firestore`.

Firestore document used:

- Collection: `timetables`
- Default document: `main`
- Default versions: `timetables/main/versions/*`

Namespace document used (institution + department + semester):

- Document: `timetables/<institution>__<department>__<semester>`
- Versions: `timetables/<institution>__<department>__<semester>/versions/*`

Security model:

- Firestore reads/writes require authenticated user.
- App signs in users anonymously for cloud operations.

## Tests

```bash
npm run test
```

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
