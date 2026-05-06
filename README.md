# Ceiba Data AI Explorer Agent

> AI-powered natural language data exploration for Ceiba Healthcare

![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-38bdf8?logo=tailwindcss)

---

## Overview

The **Ceiba Data AI Explorer Agent** is an intelligent clinical data assistant that lets healthcare teams query, visualize, and interpret complex datasets using plain English — no SQL required.

Built on Next.js 14 with a dark-themed UI, it features a Gemini-style animated chat interface, real-time SQL generation, and interactive charting.

---

## Features

- 🤖 **Natural language → SQL** — ask questions, get queries
- 📊 **Auto-visualization** — charts generated from results
- 💬 **AI Chat Panel** — Gemini-style animated glow border, streaming responses
- 🗂️ **Query Templates** — pre-built clinical query library
- 📋 **Multi-tab SQL editor** — with syntax highlighting
- 🏥 **Healthcare domain aware** — understands ICD, LOINC, patient flow

---

## Getting Started

```bash
# Install dependencies
npm install

# Run development server
npm run dev -- --port 3005

# Open in browser
open http://localhost:3005
```

---

## Project Structure

```
data-ai-explorer/
├── app/                    # Next.js app router
│   ├── api/                # API routes (query execution, AI)
│   ├── data-explorer/      # Main explorer page
│   └── dashboards/         # Saved dashboards
├── components/
│   ├── DataExplorer/
│   │   ├── ChatPanel.tsx   # AI chat UI (Gemini glow effect here)
│   │   ├── SqlPanel.tsx    # SQL editor
│   │   ├── ChartPreview.tsx
│   │   └── QueryTemplates.tsx
│   └── Sidebar/
├── styles/
│   └── globals.css         # Global styles incl. gemini-glow animation
└── MASTER_PROMPT.md        # Agent system prompt & behavioral spec
```

---

## Agent Master Prompt

See [`MASTER_PROMPT.md`](./MASTER_PROMPT.md) for the full agent specification — identity, capabilities, behavioral guidelines, interaction modes, and constraints.

---

## UI — Gemini Glow Effect

The chat input features a rotating conic-gradient border inspired by Google Gemini:

| State | Speed | Opacity |
|-------|-------|---------|
| Idle | 8s/cycle | 45% |
| Focused | 4s/cycle | 80% |
| Streaming (AI responding) | 1.8s/cycle | 100% |

Colors are configurable via CSS variables in `globals.css`:
```css
:root {
  --glow-c1: #4c8dff;  /* blue        */
  --glow-c2: #7c68ff;  /* purple      */
  --glow-c3: #c084fc;  /* pink-violet */
  --glow-c4: #22d3ee;  /* cyan        */
}
```

Respects `prefers-reduced-motion`. Safari 15.4+ supported via `@property`.

---

## Built by Ceiba Healthcare
