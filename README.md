# Consilia

**Note: This repo is still under development.**

A pipeline for extracting and structuring medieval legal opinions (*consilia*) from Transkribus PageXML transcriptions of historical prints, with a static frontend for reading and searching the results — and an MCP server that lets Claude Desktop and Claude Code interrogate the corpus directly.

The current dataset is the first volume of Baldo de Ubaldis, *Consilia* (late 15th-century Venetian print, 324 pages, 500 numbered opinions). The pipeline recovers **498 of 500** consilium numbers; the two missing (n=251, n=356) are genuinely absent from the print.

---

## Contents

1. [Prerequisites & setup](#prerequisites--setup)
2. [Project layout](#project-layout)
3. [Data layout & adding new prints](#data-layout--adding-new-prints)
4. [Running the build](#running-the-build)
5. [Output format](#output-format)
6. [Frontend](#frontend)
7. [MCP server](#mcp-server)
8. [How the pipeline works](#how-the-pipeline-works)
9. [Debug visualiser](#debug-visualiser)

---

## Prerequisites & setup

**Python 3.10 or later** is required (type-union syntax `X | Y` is used throughout).

```bash
# Clone the repository
git clone https://github.com/your-username/Consilia.git
cd Consilia

# Create a virtual environment and install dependencies
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

pip install -r requirements.txt
```

`requirements.txt` installs:

| Package | Purpose |
|---|---|
| `flair>=0.15.1` | Latin line-break detector (`mschonhardt/latin-contextual-lb-detector`) |
| `sentence-transformers>=3.0` | BGE-M3 multilingual embedding model |
| `safetensors>=0.4` | Compact binary tensor storage |
| `mcp[cli]>=1.0` | MCP server for Claude Desktop and Claude Code |

The Flair model (`mschonhardt/latin-contextual-lb-detector`) and the BGE-M3 model (`BAAI/bge-m3`) are downloaded automatically from Hugging Face on first use. BGE-M3 is approximately 2 GB; it caches in `~/.cache/huggingface/`.

---

## Project layout

```
data/
  {Author_VIAF}/                    author folder — number is the VIAF identifier
    author.json                     manual metadata: name, dates, note
    {print_id}/
      page/                         PageXML files (0001.xml … 0324.xml) from Transkribus
      0001.jpg …                    page scan images

src/
  build.py              Incremental build system — the main entry point
  pipeline.py           Direct pipeline (no staleness check)
  parse_pagexml.py      PageXML → Python dataclasses
  segment_consilia.py   Heading detection, state machine, text assembly
  lb_detector.py        Line-break dehyphenation (Flair model or heuristic)
  embed_consilia.py     BGE-M3 embedding → SafeTensors
  mcp_server.py         MCP server for Claude Desktop / Claude Code
  debug_visualize.py    Annotated JPEG output for inspection

output/
  consilia.json                       global merged consilium dictionary
  embeddings.safetensors              BGE-M3 Float32[N, 1024]
  embeddings_meta.json                index: ids, n-values, titles, author_viafs
  authors.json                        generated author index
  {Author_VIAF}/
    {print_id}.json                   per-print consilium dictionary
    consilia.json                     per-author merged dictionary
  debug/                              annotated page images (debug_visualize.py)

build_manifest.json     incremental build state (XML mtime per print)
index.html              reader frontend
search.html             keyword + semantic search frontend
vendor/
  minisearch.min.js     vendored MiniSearch (full-text search library)
pipeline_walkthrough.ipynb  Jupyter walkthrough for the article
requirements.txt
```

---

## Data layout & adding new prints

Prints are organised in a two-level hierarchy: `data/{Author_VIAF}/{print_id}/`. The VIAF number in the author folder name enables programmatic metadata lookup from the [Virtual International Authority File](https://viaf.org/).

**Current print:**

```
data/
  Baldo_29618397/
    author.json
    Baldo_Cons_Print_Venice_1575_v1/
      page/   0001.xml … 0324.xml
      0001.jpg … 0324.jpg
```

**To add a new print**, place it in the same structure and create an `author.json` for new authors:

```bash
# New author
mkdir -p data/Bartolus_89597697
cat > data/Bartolus_89597697/author.json << 'EOF'
{
  "viaf": "89597697",
  "name": "Bartolus de Saxoferrato",
  "dates": "1313–1357",
  "note": "Italian jurist, professor at Perugia"
}
EOF

# New print folder — add page/ subdirectory with PageXML and images from Transkribus
mkdir -p data/Bartolus_89597697/Bartolus_Cons_Venice_1585_v1/page
```

On the next `python src/build.py` run, the new print is detected and processed automatically. Existing prints are not re-processed unless their XML files have changed.

`author.json` fields:

| Field | Description |
|---|---|
| `viaf` | VIAF identifier (number only) |
| `name` | Display name |
| `dates` | Life dates (optional, used in frontend) |
| `note` | Brief biographical note (optional) |

---

## Running the build

### Incremental build (`build.py`) — recommended

`build.py` checks which prints have changed XML files and only re-processes those. It also regenerates the merged JSON outputs and runs the embedding stage when the data changes.

```bash
# Process all stale prints, skip embedding:
python src/build.py --no-embed

# Process all stale prints, regenerate embeddings (fp16, uses ~1 GB VRAM):
python src/build.py --embed-fp16

# Force reprocess everything:
python src/build.py --force --no-embed

# Restrict to one author:
python src/build.py --author Baldo_29618397 --no-embed

# Force re-embed only (e.g. after manual edits to consilia.json):
python src/embed_consilia.py --fp16
```

Staleness is tracked in `build_manifest.json`. A print is considered stale when any `.xml` file in its `page/` folder is newer than the manifest entry. Embeddings are regenerated when `output/consilia.json` is newer than `output/embeddings.safetensors`.

**Typical runtimes** (RTX 3060, Baldo v1, 324 pages, 501 consilia):

| Stage | Mode | Time |
|---|---|---|
| Segmentation | heuristic (`--no-lb-model`) | ~2 s |
| Segmentation | Flair model (default) | ~7 min |
| Embedding | fp16 on GPU | ~9 s |
| Embedding | CPU only | ~3 min |

### Direct pipeline (`pipeline.py`)

Processes all matching prints unconditionally — useful when iterating on the segmenter itself:

```bash
python src/pipeline.py --no-lb-model --no-embed        # fast dev cycle
python src/pipeline.py --embed-fp16                    # full run
python src/pipeline.py --author Baldo_29618397 \
  --print Baldo_Cons_Print_Venice_1575_v1 --no-embed   # single print
```

---

## Output format

All JSON outputs (global, per-author, per-print) share the same structure: a single top-level `"consilia"` object keyed by consilium ID.

```json
{
  "consilia": {
    "consilium-baldo_cons_print_venice_1575_v1-44": {
      "id":          "consilium-baldo_cons_print_venice_1575_v1-44",
      "n":           44,
      "roman":       "XLIIII",
      "volume":      "Baldo_Cons_Print_Venice_1575_v1",
      "author_viaf": "Baldo_29618397",
      "title":       "CONSILIVM XLIIII.",
      "summary":     "1 Literae principis non sunt extensibiles…",
      "body": [
        "In Christi nomine. Dominus Bailardinus…",
        "† Secunda quaestio est…",
        "† Tertia quaestio…"
      ],
      "sources": [
        {
          "page": "0030.xml",
          "regions": [
            {
              "region_id": "r1",
              "type":      "column_1",
              "coords":    [[x, y], "…"],
              "first_line": "…",
              "last_line":  "…"
            }
          ]
        }
      ]
    }
  }
}
```

| Field | Description |
|---|---|
| `id` | Unique identifier: `consilium-{print_id_lower}-{n}` |
| `n` | Arabic numeral (1–500) |
| `roman` | Roman numeral as printed |
| `volume` | Print directory name (e.g. `Baldo_Cons_Print_Venice_1575_v1`) |
| `author_viaf` | Author directory name, contains VIAF identifier (e.g. `Baldo_29618397`) |
| `title` | Full heading line as transcribed |
| `summary` | Numbered summary items before the body opener |
| `body` | List of body sections, split at every `†` paragraph marker |
| `sources` | Page file and text-region provenance for each span |

Genuine duplicate `n` values in the print (e.g. n=68 appears twice) get a `-2`, `-3` suffix on the ID.

`output/embeddings_meta.json` maps vector row indices to consilium IDs:

```json
{
  "model": "BAAI/bge-m3",
  "dims": 1024,
  "n": 501,
  "ids": ["consilium-baldo_cons_print_venice_1575_v1-1", "…"],
  "ns": [1, 2, "…"],
  "titles": ["CONSILIVM I.", "…"],
  "author_viafs": ["Baldo_29618397", "…"]
}
```

---

## Frontend

The project ships two static HTML pages that run entirely client-side, with no server-side code. They can be served from any static file host (including GitHub Pages) or opened locally with a simple HTTP server:

```bash
# Serve locally — open http://localhost:8000
python -m http.server 8000
```

> **Note:** The pages must be served over HTTP, not opened as `file://` URLs, because they fetch `output/consilia.json` via `fetch()`.

### Reader (`index.html`)

Three-panel layout:

- **Author / volume dropdowns** in the header: select which author and which print to display. Filtering by author narrows the print dropdown to that author's editions.
- **Sidebar** (230 px): scrollable list of all consilia in the selected print, kept in sync with the reader via IntersectionObserver.
- **Reader panel**: consilium cards showing the title, summary (left grey border), and body sections split at every `†`. Cards are rendered in sequence and scroll continuously.
- **Image panel** (700 px): the corresponding page scan from the Transkribus export, with `‹` / `›` navigation when a consilium spans multiple pages. Hidden on screens narrower than 1100 px.

Deep-link to a specific consilium: `index.html?n=44` — used by the search page when you click a result.

### Search (`search.html`)

Two search modes, toggled by a button pair:

**Keyword mode** uses [MiniSearch](https://lucaong.github.io/minisearch/) for instant full-text search over the selected print:

- Latin normalisation applied to both index and query: `j` = `i`, `v` = `u`, `ae`/`æ`/`ę` = `e`
- Prefix matching and fuzzy matching (terms longer than 4 characters)
- Field boost: title ×3, summary ×1.5, body ×1
- Results show which fields matched, a highlighted snippet from the best-matching field
- Stats panel: match count, field breakdown bars, distribution histogram, score range

**Semantic mode** uses the precomputed BGE-M3 embeddings for concept-level retrieval. A query can be written in Latin, German, or English — all map to the same vector space. Two embedding paths are available:

| Path | How it works |
|---|---|
| HF Serverless API | Query sent to `api-inference.huggingface.co/models/BAAI/bge-m3` (free tier, no download). An optional HuggingFace token stored in `localStorage` raises rate limits. |
| Local ONNX model | `Xenova/bge-m3` (~130 MB, quantized) downloaded via the `@xenova/transformers` CDN and cached in the browser. Fully offline after the first use. |

Both paths produce normalised 1024-dimensional vectors compatible with the precomputed embeddings. Similarity is the dot product of unit vectors (= cosine similarity). Results show the top 20 matches with:

- A color-coded score badge: warm brown ≥ 0.65 (high), amber 0.45–0.65 (medium), grey < 0.45 (low)
- A relative similarity bar sized as a fraction of the top result's score
- A 300-character snippet (summary preferred over body)
- A link to the corresponding reader card (`index.html?n=…`)

The `embeddings.safetensors` file is parsed in JavaScript without any library: 8-byte little-endian header length → JSON metadata block → raw float32 data.

---

## MCP server

`src/mcp_server.py` exposes the corpus to AI assistants (Claude Desktop, Claude Code) via the [Model Context Protocol](https://modelcontextprotocol.io/). It listens on stdio and provides two tools:

| Tool | Description |
|---|---|
| `search_consilia(query, top_k=10, author_viaf=None)` | Semantic search. Queries can be in Latin, German, or English. Returns a ranked list of `{id, n, title, author_viaf, score, snippet}`. |
| `get_consilium(consilium_id)` | Returns the full text of one consilium: `{id, n, roman, title, summary, body, author_viaf, volume}`. |

### Embedding modes

The server always loads the corpus data (JSON + SafeTensors) at startup (~0.5 s). For the actual query embedding it supports two backends, controlled by environment variables:

#### Mode 1 — HuggingFace Serverless API (default, no setup required)

The search query is sent to `api-inference.huggingface.co/models/BAAI/bge-m3`, which returns a 1024-dimensional vector. That vector is then compared against the precomputed local embeddings. **No model download required** — anyone who clones the repo can use this immediately.

This is the same path the browser search uses. The free tier works without authentication and allows a reasonable number of requests per day. For heavier use, provide a HuggingFace token:

1. Create a free account at [huggingface.co](https://huggingface.co)
2. Go to **Settings → Access Tokens → New token** (type: *Read*)
3. Copy the token (starts with `hf_…`) and pass it via the `HF_TOKEN` environment variable (see config examples below)

#### Mode 2 — Local model (fully offline)

Set `CONSILIA_LOCAL_MODEL=1` to load `BAAI/bge-m3` directly via `sentence-transformers`. The model (~2 GB) is downloaded from HuggingFace once and cached in `~/.cache/huggingface/`. After that, no internet connection is needed.

```bash
# Download the model manually (optional — happens automatically on first use)
.venv/bin/python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3')"
```

Startup time: ~7 s with a GPU (CUDA), ~30 s on CPU. Per-query cost is one `model.encode()` call plus a dot product over N unit vectors — very fast once loaded.

**When to use which mode:**

| | HF API | Local model |
|---|---|---|
| Setup effort | none | one-time ~2 GB download |
| Internet required | yes | no (after download) |
| Rate limits | yes (generous; raise with token) | none |
| Speed per query | ~1–3 s (network round-trip) | ~0.1 s (GPU) / ~1 s (CPU) |
| Privacy | query text sent to HuggingFace | stays on your machine |

### Connecting to Claude Desktop

Edit `claude_desktop_config.json` (create it if it does not exist):

- **Linux:** `~/.config/Claude/claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

**Minimal — HF API, anonymous:**
```json
{
  "mcpServers": {
    "consilia": {
      "command": "/path/to/Consilia/.venv/bin/python",
      "args": ["/path/to/Consilia/src/mcp_server.py"],
      "cwd": "/path/to/Consilia"
    }
  }
}
```

**HF API with token** (higher rate limits):
```json
{
  "mcpServers": {
    "consilia": {
      "command": "/path/to/Consilia/.venv/bin/python",
      "args": ["/path/to/Consilia/src/mcp_server.py"],
      "cwd": "/path/to/Consilia",
      "env": { "HF_TOKEN": "hf_…" }
    }
  }
}
```

**Local model** (fully offline, after downloading BAAI/bge-m3):
```json
{
  "mcpServers": {
    "consilia": {
      "command": "/path/to/Consilia/.venv/bin/python",
      "args": ["/path/to/Consilia/src/mcp_server.py"],
      "cwd": "/path/to/Consilia",
      "env": { "CONSILIA_LOCAL_MODEL": "1" }
    }
  }
}
```

After saving, restart Claude Desktop — the tools appear automatically.

### Connecting to Claude Code

[Claude Code](https://claude.ai/code) is Anthropic's CLI-based coding assistant. MCP servers are configured in `~/.claude/settings.json` (user-wide) or `.claude/settings.json` in the project root (project-scoped, loaded when Claude Code is run from this directory).

> **Note:** `.claude/` is in `.gitignore`, so the project-scoped file is not committed to the repo — each user creates it locally after cloning.

**Step 1 — Create the settings file:**

```bash
mkdir -p .claude
```

**Step 2 — Create `.claude/settings.json`** with absolute paths to your clone. Choose the env block that matches your preferred mode:

```json
{
  "mcpServers": {
    "consilia": {
      "command": "/path/to/Consilia/.venv/bin/python",
      "args": ["/path/to/Consilia/src/mcp_server.py"],
      "cwd": "/path/to/Consilia",
      "env": {
        "HF_TOKEN": "hf_…"
      }
    }
  }
}
```

Omit `env` entirely to use the anonymous HF API. Add `"CONSILIA_LOCAL_MODEL": "1"` to use the local model.

For a **user-wide setup** (active in every Claude Code session, not just this project), add the same block to `~/.claude/settings.json` instead.

**Step 3 — Verify:**

Start `claude` from the project directory and run:

```
/mcp
```

This lists all active MCP servers and their tools. If the server failed to start, the error is shown inline. You can then ask Claude to search the corpus directly:

```
search for consilia about inheritance between illegitimate children
```

```
show me the full text of consilium 267
```

**Example session:**

```
You: Search for consilia about inheritance between illegitimate children
Claude: [calls search_consilia("inheritance illegitimate children", top_k=5)]
        → returns n=267, 248, 357, 373, 258 with similarity scores

You: Show me the full text of consilium 267
Claude: [calls get_consilium("consilium-baldo_cons_print_venice_1575_v1-267")]
        → returns title, summary, and all body sections
```

---

## How the pipeline works

### 1. PageXML parsing (`parse_pagexml.py`)

Reads Transkribus PageXML files. Each page yields a list of `TextRegion` objects, each containing `TextLine` objects with:

- Unicode text
- Polygon coordinates (used for geometry-based detection)
- A soft-hyphen flag (`¬`) indicating a word split at the line end

Running-header regions (type `header`) are skipped everywhere.

### 2. Consilium segmentation (`segment_consilia.py`)

This is the core stage. It turns the flat stream of text lines into structured consilium records using a state machine with several pre-processing passes.

#### Pre-processing passes

**Colinear split merge** (`_merge_colinear_splits`): Transkribus occasionally segments a single printed heading line into two side-by-side `TextLine` objects (e.g. `CONSILIVM` and `CCCLIII.` as separate XML elements in the same text region at the same vertical position). These are merged before any other processing. Recovered 4 headings.

**Text-based split-heading merge** (`merge_split_headings`): Consecutive narrow all-caps lines that individually do not match the heading regex but together do (in any ordering) are merged. Handles cases like `['CCLXIX.', 'CONSILIVM.']` → `'CONSILIVM CCLXIX'`. Recovered 7 headings.

#### Heading detection

Three strategies in priority order:

1. **Regex** (`_RE_HEADING`): Matches `CONSILIVM` + Roman numeral with extensive OCR-error variants:
   - Standard and doubled-I: `CONSILI`, `CONSILII`, `CONSIILI`
   - Missing letters: `COSILI`, `CNSILI`, `CONILI`, `ONSILI`, `NSILI`
   - Misread letters: `CONSLLI`, `CONSILR`
   - Severely truncated prefixes: `LIVM`, `IVM`, `VM` (up to 4 leading garbage characters)
   - Optional `Ad idem.` prefix; optional leading marginal paragraph number
   - Trailing OCR noise (up to 20 characters after the period)
   - `S` treated as OCR misread of `C` in Roman numerals

2. **OCR normalisation** (`_normalize_ocr_e`): Before applying the regex a second time, `e` is replaced by `C` when sandwiched between Roman numeral characters (handles `CCceV` → `CCCCV` = 405). Applied surgically to avoid false matches in body text.

3. **Geometric fallback**: Lines narrower than 58% of their column width, consisting of all-caps text with at least 4 alphabetic characters, that are not numbered summary items, are treated as headings when the segmenter is in BODY or BEFORE state. Recovers headings where the numeral was so garbled the regex gives up entirely.

4. **Arabic-numeral headings** (`_RE_ARABIC_HEADING`): Handles the non-standard format `Consilium 473. et 414.` where two consilia are referenced with Arabic numerals. Both numbers are extracted; the secondary one is emitted as a clone and corrected by sequence healing.

#### State machine

```
BEFORE  → (heading detected)                → SUMMARY
SUMMARY → (body opener: "In Christi nomine" or leading †) → BODY
SUMMARY → (next heading)                    → SUMMARY  [flush previous consilium]
BODY    → (next heading)                    → SUMMARY  [flush previous consilium]
```

Summary lines accumulate until a body opener is found. Body lines accumulate until the next heading.

#### Sequence healing (`_heal_sequence`)

After segmentation, a post-processing pass corrects OCR-garbled Roman numerals that produced a plausible but wrong number. For each consilium whose `n` is out of sequence relative to its neighbours in page order:

- If exactly one number is missing in the range `(prev_n, next_n)`, the consilium is reclassified to that number.
- Geometric headings with `n=0` are assigned a number if only one is missing between their neighbours.
- All IDs are rebuilt after healing to remove stale duplicate suffixes.

Recovered ~18 consilia via healing (e.g. `CXIII` → n=93, `CCXXXVIII` → n=228).

#### Text assembly

**Summary**: Lines are joined with the Flair model (or the `¬`-heuristic). Numbered summary items (e.g. `1 Feudum an…`) retain their leading numbers. Standalone marginal-number lines (a bare `1` with no content) are dropped.

**Body sections**: All body lines are joined into a full text first, then split at every `†` character (keeping `†` at the start of its section). This correctly handles `†` markers that appear mid-line in the XML (where the physical line boundary cut through the printed text). Marginal paragraph numbers (1–10) at line starts are stripped before joining.

### 3. Line-break dehyphenation (`lb_detector.py`)

Joins the lines of each text section into a single string. Two modes:

**Heuristic** (`--no-lb-model`): Lines ending with `¬` are merged directly with the next line (word continues); all other line breaks get a space. Fast but misses invisible breaks.

**Flair model** (default): Each adjacent line pair is passed as one sentence `"line_i <lb/> line_i+1"` to the sequence tagger `mschonhardt/latin-contextual-lb-detector`. The model predicts a label on the `<lb/>` token:

- `WB` — merge the two lines directly (word continues across the break)
- `NB` — insert a space (word boundary at the line break)

All pairs for a section are batch-predicted in a single `tagger.predict()` call. The model was trained on pairs; each sequence contains exactly one `<lb/>` token.

### 4. Embedding (`embed_consilia.py`)

Generates a dense vector representation for every consilium using [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3), a multilingual sentence embedding model with 1024 dimensions and support for up to 8192 tokens. Each consilium is represented by its title, summary, and body sections joined into one passage.

Embeddings are saved as `output/embeddings.safetensors` (compact binary format) alongside `output/embeddings_meta.json`.

**Why BGE-M3?** Queries can be posed in Latin, German, or English — all map to the same vector space, so a German question finds the corresponding Latin texts without translation.

**SafeTensors binary layout** (for the inline JavaScript parser in `search.html`):

```
[8 bytes: little-endian uint64, header length]
[header_length bytes: UTF-8 JSON metadata]
[raw float32 data, row-major, shape [N, 1024]]
```

---

## Debug visualiser (`debug_visualize.py`)

Writes annotated JPEG images and a coverage report for inspection:

```bash
python src/debug_visualize.py --volume Baldo_Cons_Print_Venice_1575_v1
python src/debug_visualize.py --volume Baldo_Cons_Print_Venice_1575_v1 --pages-only
```

Output in `output/debug/Baldo_Cons_Print_Venice_1575_v1/`:

- `{page}_debug.jpg` — page image with colour-coded bounding boxes
- `coverage.txt` — detected consilium numbers, gaps, per-page heading list

Box colours:

| Colour | Meaning |
|---|---|
| Green | Heading matched by regex |
| Orange | Heading detected by geometric fallback |
| Cyan | Heading produced by merging split lines |
| Red | Heading with no detectable body opener |
| Purple | Near-miss candidate — not detected, shown for inspection |
