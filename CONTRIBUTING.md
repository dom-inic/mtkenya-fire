# Contributing

Thanks for helping. This project aims to be useful to people who fight fires
on Mount Kenya, and to anyone building the same for other mountains. Issues,
fixes, data and field knowledge are all welcome.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

Requirements: Node 20+ with pnpm, Python 3.12–3.13 with [uv](https://docs.astral.sh/uv/).

```bash
cp .env.example .env    # FIRMS key and Mapbox token (both free)

cd web
pnpm install
pnpm dev                # http://localhost:3000, uses the committed data
```

You only need the pipeline if you change how data is built:

```bash
cd pipeline
uv sync
uv run python build.py --no-world   # incident data (~10 min first time)
uv run python build.py --world-only # 3D world data (~15 min first time)
```

See the [README](README.md) for what each part does.

## Before you open a pull request

```bash
cd web && pnpm lint && npx tsc --noEmit && pnpm build
cd pipeline && uvx ruff check .
```

CI runs the same checks.

- Keep changes focused; one topic per pull request.
- Match the style of the surrounding code: names, comment density, one import
  per line in Python.
- If you change the model or its parameters, say how the fit changed (the
  build prints the Sørensen scores) and update the README's numbers.
- If you regenerate `web/public/data`, mention it. Those files are large, so
  only commit them when the change needs it.
- Don't commit `.env`, `pipeline/cache/` or `web/.data/`.

## Useful contributions

- **Field knowledge:** fuel types and moorland conditions, how fires actually
  behave on the mountain, access routes, where crews stage, realistic aircraft
  and crew numbers. Open an issue; you don't need to write code.
- **Spotting:** embers jumping ahead (for example across Kathita Gorge) are
  missing from the spread model.
- **Fuels:** replace land-cover-based fuel types with field-surveyed ones.
- **Tests:** there are none yet. The TypeScript engine (`web/lib/engine.ts`,
  `web/lib/suppression.ts`) and the incident logic (`web/lib/hotspots.ts`)
  are pure functions and good places to start.
- **Other mountains:** most of the pipeline is parameterised in
  `pipeline/mkfire/config.py` and `world.py`. Generalising it (Aberdares,
  Mt Elgon, Kilimanjaro) would help many more people.
- **Live mode for real use:** logins, a database instead of the file store,
  tested alert channels.

## Reporting bugs and security issues

Use the issue templates for bugs and ideas. Report security problems
privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Licence

Contributions are accepted under the [Apache-2.0 licence](LICENSE): by
submitting a pull request you agree your work is licensed under it. Data you
add must come with its source and licence (see [DATA_LICENSES.md](DATA_LICENSES.md)).
