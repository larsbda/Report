# Morning

A private morning report: weather, your calendar, top stories from WSJ / DN / NRK, and a few arXiv papers.
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

The weather follows your calendar automatically, using the events' **Location** field:

- Location is a city (`Sanya`): you're there from the event's start until 24 hours after it ends.
- Location is a route (`Shenzhen East to Sanya`): you're at the origin during the trip and at the destination after it.
- A travel title ending in "to X" (`…and flight to Kunming`, `Night train to Sanya`): you're in X after it ends.
- Stations, airports and addresses are reduced to their city. Non-city locations (`Café X`) are ignored.

The most recently started place wins, and after 24 hours with no place it goes back to the default city.
To force a city, add an event titled `📍 Oslo` (or `City: Oslo`). It wins while it lasts and is hidden from
the agenda. Picking a city by hand with "Change weather location" overrides the calendar for the rest of that day.

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
- Story links open the publisher (WSJ, DN, NRK). DN opens logged in through your DN subscription.
- WSJ replaced FT, because FT.com is restricted on NTNU's academic Factiva account while WSJ is a Dow Jones
  title like Factiva itself. WSJ stories get **Read in Factiva ↗**. Factiva has no link to a specific article
  from outside, so the button copies a keyword search ("Campaign and Bring and Jensen and Huang") and opens
  Factiva; paste it into the search. If Factiva's search page takes the query in its address, set
  `FACTIVA_SEARCH` in `web/app.js` and the button opens the results directly.
- The build never fetches article text from Factiva or anywhere else: that would break the licence terms
  and publish licensed content.
