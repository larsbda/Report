# Morning

A private morning report: weather, your calendar, top stories from FT / DN / NRK, and a few arXiv papers.
It's a static web app on GitHub Pages, installed on the phone with "Add to Home Screen".

## How it works

- A GitHub Action (`.github/workflows/build.yml`) runs at 04:40 Shanghai time and then every 3 hours.
  It fetches the RSS feeds, arXiv and your calendar, ranks the stories, **encrypts everything** with your
  passphrase (AES-256-GCM, PBKDF2-SHA256 with 300k iterations), and deploys to Pages.
- The page shows only a lock screen until the passphrase is entered. The passphrase is then remembered on
  that device. "Lock" at the bottom forgets it.
- Weather (Open-Meteo, including Shanghai's AQI) is fetched live by the phone when you open the app.
- Ranking is a plain heuristic: the editors' order in the feed, plus keyword topics (economy, finance, AI,
  politics, iPhone), minus sport and celebrity stories, minus age. Near-duplicate stories are merged.
  To tune it, edit `scripts/config.mjs`.

The code is public. The news, papers and calendar are only ever published encrypted.

## Setup

1. Repo → Settings → Pages → Source: **GitHub Actions**.
2. Repo → Settings → Secrets and variables → Actions → New repository secret:
   - `REPORT_PASSPHRASE`: a long passphrase (4–5 random words). This is the only thing protecting the data.
   - `CALENDAR_ICS_URL` (optional): see below.
3. Actions → "Build morning report" → Run workflow.
4. On the phone, open `https://larsbda.github.io/Report/` in Safari → Share → Add to Home Screen.
   Open it from the home screen and enter the passphrase once. (The home-screen app has its own storage,
   separate from Safari, so you enter it there.)

### Apple Calendar

On a Mac: Calendar → right-click the calendar → Share Calendar… → tick **Public Calendar** → copy the
`webcal://…` link. (On iCloud.com: Calendar → the share icon next to the calendar → Public Calendar.)
Put that link in the `CALENDAR_ICS_URL` secret. For several calendars, put several links separated by spaces.

"Public" here means anyone who has the link can read the calendar. The link is a long random URL, and it is
only stored as a GitHub secret, never published.

### Weather location from the calendar

Add an all-day event titled `📍 Oslo` (or `City: Oslo`, `Weather: Portland, Maine`) covering the days you're
there. The weather shows that city while the event lasts, then goes back to the default. Picking a city by
hand with "Change weather location" overrides the calendar for the rest of that day. Place events are not
shown in the agenda.

## Local development

```sh
REPORT_PASSPHRASE=test WRITE_PLAINTEXT=1 node scripts/build.mjs   # data.debug.json shows the ranking
python3 -m http.server -d dist 8000                               # open http://localhost:8000, unlock with "test"
```

`scripts/make_icons.py` regenerates the app icons.

## Notes

- GitHub pauses scheduled workflows on public repos after 60 days without commits. If the report stops
  updating, push any commit or press "Run workflow".
- If a feed or arXiv fails during a run, the previous run's items for that section are kept.
