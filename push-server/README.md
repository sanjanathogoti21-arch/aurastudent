# AuraStudent push server

A small Cloudflare Worker that stores reminder times and sends them as Web Push at the right minute.
Setup guide with copy buttons: open `push-setup.html` on the hosted site.
Needs a D1 database bound as `DB`, a cron trigger `* * * * *`, and the settings `VAPID_PUBLIC`, `VAPID_PRIVATE`, `TOKEN`, `ALLOWED_ORIGIN`.
