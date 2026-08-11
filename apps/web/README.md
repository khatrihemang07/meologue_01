# @meologue/web

The web app shell — Vite, React 19, Tailwind v4, shadcn/ui over Radix. No meologue behaviour
yet; see ticket #10 for wiring up Send/History.

## Development

```
pnpm dev
```

The dev server proxies `/v1/*` to the Rust server at `http://localhost:8080`, so the client
only ever uses relative URLs and never needs to know its own host. Run the server separately
(`cargo run` in `server/`, with Postgres up via `docker-compose up -d`) for requests to resolve.
