#!/usr/bin/env bash
# Finishes Telegram setup: reads the chat id from the bot's pending updates,
# writes it to .env for local runs, and stores it as a GitHub Actions secret.
# Run this AFTER sending your bot any message on Telegram.
set -euo pipefail
cd "$(dirname "$0")"

TOK="$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-)"
[ -n "$TOK" ] || { echo "TELEGRAM_BOT_TOKEN missing from .env"; exit 1; }

CHAT_ID="$(curl -sS "https://api.telegram.org/bot${TOK}/getUpdates" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("ok"):
    sys.exit("Telegram API error: " + str(d.get("description")))
for u in reversed(d.get("result", [])):
    m = u.get("message") or u.get("channel_post") or {}
    c = m.get("chat") or {}
    if c.get("id"):
        print(c["id"]); break
')"

if [ -z "$CHAT_ID" ]; then
  echo "No messages found. Open Telegram, send @diljitbooking_bot any message, then run this again."
  exit 1
fi

echo "Found chat id: $CHAT_ID"
python3 - "$CHAT_ID" <<'PY'
import sys, pathlib
cid = sys.argv[1]
p = pathlib.Path(".env")
out = [f"TELEGRAM_CHAT_ID={cid}" if l.startswith("TELEGRAM_CHAT_ID=") else l
       for l in p.read_text().splitlines()]
p.write_text("\n".join(out) + "\n")
PY
printf '%s' "$CHAT_ID" | gh secret set TELEGRAM_CHAT_ID
echo "Secret stored. Sending a test alert through the cloud workflow..."
gh workflow run "Ticket watcher" -f test_alert=true
echo "Done. Check your phone in about 30 seconds."
