# Tor Radar

Static, GitHub-native Tor relay intelligence dashboard.

The project collects public Tor relay data once per hour, stores compact snapshots in
the repository, and renders an interactive dashboard without a database or backend.

## Data Sources

- `https://www.dan.me.uk/torlist/?full` for a full public Tor IP list.
- `https://onionoo.torproject.org/details` for official relay metadata from the Tor Project.

## What It Builds

- `data/current/network.json`: latest enriched network snapshot.
- `data/snapshots/*.json`: hourly snapshots, retained for the most recent 168 runs by default.
- `data/history/summary.csv`: compact time series for charts.
- `data/history/summary.jsonl`: compact machine-readable time series.
- `public/`: static dashboard files.
- `public/assets/`: dashboard CSS and JavaScript.

## Local Update

```bash
python3 scripts/update.py
```

Build a local preview directory that matches the GitHub Pages artifact:

```bash
rm -rf site
cp -R public site
cp -R data site/data
python3 -m http.server 8080 --directory site
```

Then open `http://127.0.0.1:8080/`.

## GitHub Pages

The workflow in `.github/workflows/tor-radar.yml` updates data hourly and deploys
the static site to GitHub Pages. It copies `public/` as the Pages root and adds
`data/` next to it, so the dashboard can fetch `data/current/network.json`.

The Pages artifact is rooted at `public/`, so the deployed site opens at `/`.

Repository settings needed:

- Enable GitHub Pages.
- Set Pages source to GitHub Actions.
- Allow GitHub Actions to read and write repository contents.

## Retention

Defaults:

- Snapshots: last 168 hourly files.
- Summary history: last 720 rows.

Override in workflow env:

- `TOR_RADAR_SNAPSHOT_RETENTION`
- `TOR_RADAR_HISTORY_RETENTION`
- `TOR_RADAR_DAN_REFRESH_HOURS`
- `TOR_RADAR_USER_AGENT`

## Notes

This is an observational public-data project. Avoid making attribution claims from
hosting concentration alone; the UI should present concentration, churn, and relay
metadata as signals, not as accusations.
