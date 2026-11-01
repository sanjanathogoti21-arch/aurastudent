# AuraStudent

A personal student planner I built as a first-year B.Tech student at NIAT. It puts classes, deadlines, hackathons, communities and online courses in one place, and plans study time around them.

**Try it:** https://sanjanathogoti21-arch.github.io/aurastudent/  (opens empty, you fill in your own details)

## What it does
- Calendar and tasks with clash detection and a smart study plan
- Hackathon, community and course tracking, with dates marked "confirmed" or "needs verification"
- Reminders before classes and deadlines, including a due time on tasks
- Installs on phone and laptop as a PWA and works offline
- Backup and restore as a JSON file

## Phone alerts and sync (one tap, no setup)
- **Alerts when the app is closed** and **sync between devices** are one tap in Profile. Users enter nothing. Reminder text and synced data are encrypted on the device (sync uses a code only the user has), so the shared server only sees delivery times and unreadable data. The app works fully on one device without them. Server owner guide: `push-setup.html`.

## Privacy
Everything is stored in your own browser. There is no account and no analytics. If a user turns on alerts or sync, encrypted data goes to the shared AuraStudent server (a free Cloudflare Worker). The free plan serves tens of daily users, not thousands.

## How it is built
Plain HTML, CSS and JavaScript in a single file (`index.html`), a service worker (`sw.js`) for offline use and notifications, and an optional Cloudflare Worker (`push-server/worker.js`) with a D1 database for Web Push and sync.

## Honest note
I built this with AI assistance (Claude). I decided what it should do, tested it on real devices, and found and reported the bugs. I'm now learning JavaScript properly to build the next project myself.

## Known limits
- Alerts with the screen off need the optional server and depend on the phone's battery settings
- Not on app stores
