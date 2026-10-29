# Security

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. If that isn't
available, message the maintainer (`dom-inic`) on GitHub and ask for a private
channel.

Include what you found, how to reproduce it, and what it affects. You'll get
an acknowledgement within a week.

## Status

This is a research prototype. Before you deploy live mode anywhere real:

- There are **no user logins.** Anyone who can reach the server can read field
  reports and photos.
- Set `REPORT_TOKEN` (posting reports) and `ALERT_CHECK_TOKEN` (running the
  alert check). Without them, those endpoints are open.
- Reports, photos and the alert log are stored as files in `web/.data/`. Use a
  database and access control for real use, and treat photos and GPS positions
  as personal data.
- Keep `.env` out of version control. `FIRMS_MAP_KEY` and the alert-channel
  credentials are read only on the server; only `NEXT_PUBLIC_MAPBOX_TOKEN` is
  sent to browsers (use a public, URL-restricted Mapbox token).

## Not a safety system

Forecasts, control-line suggestions and alerts come from a simplified model
and satellite data that can be hours old or miss fires entirely. Don't rely on
this software for decisions that affect life or safety. Follow the
instructions of KWS, KFS and incident commanders on the ground.
