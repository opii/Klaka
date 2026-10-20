# klaka-core

Naš sistem, Rust (Cargo workspace): `klaka-core`, `klaka-collector`, `klaka-engine`, `klaka-llm`, `klaka-api`.
Vidi `docs/tech_stack.md` §2–§3.

```
cargo check
```

- `spec/` — protokol (token pregleda, šema događaja, presude) + `test-vectors/` koje SDK-ovi moraju da prođu.
- `deploy/` — docker compose za self-hosted.
