# diljitbot

Watches the Diljit Dosanjh Aura World Tour pages and alerts you the moment tickets go on sale.

**Phase 1 (this repo):** poll-and-alert watcher, running either on GitHub Actions or on your Mac.
**Phase 2 (not built yet):** browser-assist that opens the event page, picks category and quantity, then hands off. It will never solve CAPTCHAs, enter OTPs, or touch payment details.

Watched pages:

- `https://www.diljitdosanjh.com/tour/ahmedabad/` — Sat 21 Nov 2026, Narendra Modi Stadium
- `https://www.diljitdosanjh.com/tour/` — tour index, where a new ticket link would surface first

## What triggers an alert

- A link appears pointing at a known ticketing host: BookMyShow, District, Zomato Live, Paytm Insider, Ticketmaster and others.
- On-sale wording appears, such as "Buy tickets", "Book now", "Tickets available".
- Pre-sale wording disappears, such as "Fan registration" or "Count me in".
- Any other change to the page's visible text, reported as unclassified.

Script and style tags are stripped before fingerprinting, so Next.js build hashes do not cause false alarms.

## Telegram setup

Both deployment modes need a Telegram bot.

1. Message [@BotFather](https://t.me/BotFather), run `/newbot`, copy the token.
2. Open a chat with your new bot and send it any message.
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat.id` value.

## Running on GitHub Actions (primary)

The workflow in `.github/workflows/watch.yml` runs on GitHub's runners, so nothing
depends on your laptop being awake. Actions minutes are free and unlimited on
public repositories.

It does not rely on a frequent cron. GitHub runs scheduled workflows on a
best-effort basis and drops high-frequency ones under load: a `*/5` schedule
produced zero runs here in 28 minutes. Instead the schedule fires twice an hour
and each run then polls internally every 60 seconds for 55 minutes. Only one
trigger per half hour has to land. If one is dropped the next recovers, and
because the concurrency group queues at most one run, coverage stays continuous.

Detection lag is therefore about 60 seconds, not 5 to 15 minutes.

Set the two secrets once. With the token already in `.env`, send your bot any
message on Telegram and then run:

```bash
./finish-setup.sh
```

That reads the chat id from the bot's pending updates, writes it to `.env`, stores
it as a repository secret, and fires a test alert. To set either value by hand
instead:

```bash
gh secret set TELEGRAM_BOT_TOKEN
gh secret set TELEGRAM_CHAT_ID
```

### Rotating the bot token

If the token is ever exposed, message [@BotFather](https://t.me/BotFather), pick the
bot, and use `/revoke` to issue a new one. Then update `.env` and re-run
`gh secret set TELEGRAM_BOT_TOKEN`. A leaked token lets anyone send messages as
your bot, but it grants no access to your Telegram account.

Confirm alerts reach your phone:

```bash
gh workflow run "Ticket watcher" -f test_alert=true
```

Watch a run live:

```bash
gh run watch
```

Page state is committed to `state/ci-state.json` after every change, so the commit history doubles as a log of exactly what changed on the page and when. Runs never overlap, and a failed run sends its own Telegram warning so the watcher cannot go blind silently.

### Caveat

GitHub disables scheduled workflows after 60 days without repository activity, and it emails you first. The show is about two months out, so this sits right at the edge. If you get that email, re-enable it from the Actions tab or run `gh workflow enable "Ticket watcher"`.

## Running locally (optional second pair of eyes)

```bash
cp .env.example .env   # then fill in the two Telegram values
npm start
```

Polls every 15 seconds and adds a macOS notification, a spoken alert, and auto-opens the first ticket link. Local state lives in `state/state.json`, which is gitignored and kept separate from the CI state. Reset the baseline with `npm run reset`.

Your Mac sleeps after 1 minute idle, which stops the watcher. Either wrap it in `caffeinate -is npm start` and leave the lid open, or install the launchd agent:

```bash
sed "s#__DIR__#$(pwd)#g; s#__NODE__#$(command -v node)#g" com.diljitbot.watcher.plist > ~/Library/LaunchAgents/com.diljitbot.watcher.plist
launchctl load ~/Library/LaunchAgents/com.diljitbot.watcher.plist
```

launchd survives reboot and logout. It does not survive sleep. GitHub Actions is the reliable path.

## Legal note

This phase reads public HTML from a site whose `robots.txt` allows all crawlers on all paths. Phase 2 is a different matter: both likely ticketing platforms disallow automated access to their checkout, payment and order paths, and automating those would breach their terms. Keep a human at every gate.
