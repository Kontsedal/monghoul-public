<p align="center">
  <img src="https://monghoul.com/og-image.webp" alt="Monghoul — MongoDB GUI" width="700" />
</p>

<h1 align="center">Monghoul</h1>

<p align="center">
  A fast, beautiful MongoDB GUI for developers who care about their tools.
</p>

<p align="center">
  <a href="https://monghoul.com">Website</a> ·
  <a href="https://monghoul.com/features">Features</a> ·
  <a href="https://monghoul.com/download">Download</a> ·
  <a href="https://monghoul.com/pricing">Pricing</a> ·
  <a href="https://github.com/Kontsedal/monghoul-public/releases">Releases</a>
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white" />
  <img alt="macOS" src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black" />
  <img alt="License" src="https://img.shields.io/badge/license-proprietary-blue" />
</p>

---

## What is Monghoul?

Monghoul is a desktop MongoDB client. It's designed to be fast, lightweight (~33 MB installer), and packed with developer-focused features.

### Highlights

- **Query editor** with schema-aware autocomplete — field paths, operators, pipeline stages, enum values, index hints
- **Visual aggregation builder** with drag-and-drop, live preview, $lookup form helper, and code sync
- **8 chart types** with dual axis, date aggregation, and PNG export
- **Cluster monitoring** with sparkline charts, slow query analysis, and database profiler
- **70+ MCP tools** for AI assistant integration (Claude, Cursor, Windsurf, Codex, Gemini)
- **10 built-in themes** and a full theme editor with 3-color generation
- **Import/export** in JSON, CSV, Excel, and cross-instance collection copy
- **8 auth methods** — SCRAM, x509, LDAP, Kerberos, AWS IAM
- **SSH tunneling** and SSL/TLS with custom certificates
- **Write protection** with per-connection scope and 25+ destructive operation detection

## Download

| Platform | Format | Link |
|----------|--------|------|
| **Windows** | .exe installer | [Latest Release](https://github.com/Kontsedal/monghoul-public/releases/latest) |
| **macOS** | .dmg | [Latest Release](https://github.com/Kontsedal/monghoul-public/releases/latest) |
| **Linux** | .deb / .rpm | [Latest Release](https://github.com/Kontsedal/monghoul-public/releases/latest) |

Or visit [monghoul.com/download](https://monghoul.com/download) for detailed install instructions.

## Free vs Pro

Monghoul has a generous free tier — no time limit, no credit card required.

| | Free | Pro |
|---|---|---|
| Connections | 5 | Unlimited |
| Tabs per panel | 5 | Unlimited |
| Favorites & pinned | 5 each | Unlimited |
| Charts & visualization | — | ✓ |
| Cluster monitoring | — | ✓ |
| MCP server (AI tools) | — | ✓ |
| Multi-panel layout | — | ✓ |
| Document diff | — | ✓ |
| Custom themes | — | ✓ |
| Excel import/export | — | ✓ |
| Enterprise auth (x509, LDAP, Kerberos, AWS IAM) | — | ✓ |

See [monghoul.com/pricing](https://monghoul.com/pricing) for full details.

## Issues & Feature Requests

Found a bug or have a feature idea? [Open an issue](https://github.com/Kontsedal/monghoul-public/issues/new).

Please include:
- **Bug reports**: OS, app version, steps to reproduce, and any error messages
- **Feature requests**: describe the problem you're trying to solve, not just the solution

## Links

- [Website](https://monghoul.com)
- [Features](https://monghoul.com/features)
- [Pricing](https://monghoul.com/pricing)
- [Privacy Policy](https://monghoul.com/privacy)
- [Terms of Service](https://monghoul.com/terms)
- [EULA](https://monghoul.com/eula)

## Tech Stack

Built with [Tauri](https://tauri.app) and [Bun](https://bun.sh). ~33 MB installer, no bundled Chromium.
