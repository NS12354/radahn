#!/usr/bin/env bash
# Upload the sign-in email templates (supabase/templates) to the Supabase project and
# set 6-digit codes. Emails carry a code, not a link: mail scanners open links and use
# them up before the person clicks.
#
#   SUPABASE_ACCESS_TOKEN=sbp_... bash scripts/supabase-auth-emails.sh
#
# Token: supabase.com/dashboard/account/tokens (revoke it afterwards if you like).
set -euo pipefail
REF="${SUPABASE_PROJECT_REF:-lmfmodxhsvdijwjneofg}"
: "${SUPABASE_ACCESS_TOKEN:?Set SUPABASE_ACCESS_TOKEN (supabase.com/dashboard/account/tokens)}"
cd "$(dirname "$0")/../supabase/templates"

body=$(node -e '
const fs = require("fs"), r = f => fs.readFileSync(f, "utf8");
process.stdout.write(JSON.stringify({
  mailer_otp_length: 6,
  mailer_subjects_confirmation: "Confirm your Formframe account",
  mailer_templates_confirmation_content: r("confirm.html"),
  mailer_subjects_magic_link: "Your Formframe sign-in code",
  mailer_templates_magic_link_content: r("magic.html"),
  mailer_subjects_recovery: "Reset your Formframe password",
  mailer_templates_recovery_content: r("recovery.html"),
}));')

out=$(mktemp); trap 'rm -f "$out"' EXIT
status=$(curl -sS -o "$out" -w '%{http_code}' -X PATCH \
  "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  --data "$body")
if [ "$status" = 200 ]; then echo "Email templates updated (6-digit codes)."
else echo "Supabase answered HTTP $status:" >&2; head -c 500 "$out" >&2; echo >&2; exit 1; fi
