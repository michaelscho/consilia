#!/usr/bin/env bash
# =============================================================================
# Phase 1 Tagging & Translation via Gemini CLI (robuste Version)
# -----------------------------------------------------------------------------
# Speichert IMMER den Roh-Output, versucht dann zu parsen.
# Failed Parses landen als .raw.txt-Datei daneben.
# =============================================================================

set -uo pipefail   # KEIN -e: einzelne Fehler dürfen den Lauf nicht killen

# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------
INPUT_FILE="/home/micha/github/Consilia/output/Baldo_29618397/Baldo_Cons_Print_Venice_1575_v1.json"
OUTPUT_DIR="/home/micha/github/Consilia/output/Baldo_29618397/phase1_gemini"
PROMPT_FILE="$(dirname "$0")/phase1_prompt.md"

MODEL="${1:-gemini-2.5-flash}"   # via CLI-Arg überschreibbar: ./script.sh gemini-2.5-pro
N_RUNS=3
SLEEP_BETWEEN=7                  # Flash: 10 RPM = 6s minimum; mit Puffer 7s
DEBUG="${DEBUG:-0}"              # DEBUG=1 ./script.sh für ausführliches Logging

mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Sanity-Checks
# ---------------------------------------------------------------------------
command -v gemini >/dev/null 2>&1 || { echo "FEHLER: gemini CLI nicht gefunden."; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FEHLER: jq nicht gefunden (sudo apt install jq)."; exit 1; }
[[ -f "$INPUT_FILE" ]] || { echo "FEHLER: Input nicht gefunden: $INPUT_FILE"; exit 1; }
[[ -f "$PROMPT_FILE" ]] || { echo "FEHLER: Prompt-Datei fehlt: $PROMPT_FILE"; exit 1; }

PROMPT_TEMPLATE="$(cat "$PROMPT_FILE")"

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
N_CONSILIA=$(jq -r '.consilia | length' "$INPUT_FILE")
echo "[$(date +%H:%M:%S)] Gefunden: $N_CONSILIA Consilia"
echo "[$(date +%H:%M:%S)] Modell: $MODEL | Runs: $N_RUNS | Sleep: ${SLEEP_BETWEEN}s"
echo "[$(date +%H:%M:%S)] Output-Verzeichnis: $OUTPUT_DIR"
echo "[$(date +%H:%M:%S)] Debug: $DEBUG (DEBUG=1 für mehr Logs)"
echo ""

CONSILIUM_IDS=$(jq -r '.consilia | keys[]' "$INPUT_FILE")

# ---------------------------------------------------------------------------
# Hilfsfunktion: extrahiert die Modell-Antwort aus dem CLI-Output
# ---------------------------------------------------------------------------
extract_response() {
    local raw="$1"

    # Versuch 1: --output-format json liefert {"response": "...", "stats": ...}
    # Aber die CLI gibt manchmal Log-Zeilen davor aus.
    local json_start
    json_start=$(echo "$raw" | grep -n '^{' | head -1 | cut -d: -f1)

    if [[ -n "$json_start" ]]; then
        local json_part
        json_part=$(echo "$raw" | tail -n +"$json_start")
        if echo "$json_part" | jq -e '.response' >/dev/null 2>&1; then
            echo "$json_part"
            return 0
        fi
    fi

    # Versuch 2: Der raw-Output ist selbst schon das Modell-JSON
    if echo "$raw" | jq -e '.tags' >/dev/null 2>&1; then
        jq -n --argjson model_json "$raw" '{response: ($model_json | tostring), stats: null}'
        return 0
    fi

    # Versuch 3: Markdown-Codeblock entfernen
    local cleaned
    cleaned=$(echo "$raw" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//' | sed '/^$/d')
    if echo "$cleaned" | jq -e '.' >/dev/null 2>&1; then
        jq -n --argjson model_json "$cleaned" '{response: ($model_json | tostring), stats: null}'
        return 0
    fi

    return 1
}

# ---------------------------------------------------------------------------
# Hauptschleife
# ---------------------------------------------------------------------------
i=0
for cid in $CONSILIUM_IDS; do
    i=$((i + 1))
    echo "[$(date +%H:%M:%S)] [$i/$N_CONSILIA] $cid"

    title=$(jq -r --arg id "$cid" '.consilia[$id].title // "—"' "$INPUT_FILE")
    author=$(jq -r --arg id "$cid" '.consilia[$id].author_viaf // "unbekannt"' "$INPUT_FILE")
    summary=$(jq -r --arg id "$cid" '.consilia[$id].summary // "—"' "$INPUT_FILE")
    body=$(jq -r --arg id "$cid" '.consilia[$id].body | join("\n\n")' "$INPUT_FILE")

    prompt=$(
        cat <<EOF
$PROMPT_TEMPLATE

---
Consilium-ID: $cid
Autor (VIAF): $author
Titel: $title

Editorisches Summary (nur Kontext, NICHT als Quelle für text_quote verwenden):
$summary

Lateinischer Quelltext (HIERAN wird verschlagwortet und übersetzt):
---
$body
---

Antworte AUSSCHLIESSLICH mit gültigem JSON gemäß dem oben definierten Schema.
EOF
    )

    for run in $(seq 1 "$N_RUNS"); do
        safe_cid="${cid//\//_}"
        safe_cid="${safe_cid//:/_}"
        out_file="$OUTPUT_DIR/${safe_cid}__run${run}.json"
        raw_file="$OUTPUT_DIR/${safe_cid}__run${run}.raw.txt"

        if [[ -f "$out_file" ]] && jq -e '.status == "ok"' "$out_file" >/dev/null 2>&1; then
            echo "    Run $run: bereits vorhanden (ok), überspringe."
            continue
        fi

        echo "    Run $run/$N_RUNS → $(basename "$out_file")"

        gemini_output=$(
            echo "$prompt" | gemini \
                -m "$MODEL" \
                --output-format json \
                2>&1
        )
        rc=$?

        # IMMER Roh-Output speichern (fürs Debuggen)
        echo "$gemini_output" > "$raw_file"

        if [[ "$DEBUG" == "1" ]]; then
            echo "    --- DEBUG: erste 5 Zeilen Roh-Output ---"
            echo "$gemini_output" | head -5 | sed 's/^/    | /'
            echo "    --- ende ---"
        fi

        if [[ $rc -ne 0 ]]; then
            echo "    WARNUNG: gemini exit $rc"
            jq -n \
                --arg cid "$cid" \
                --arg run "$run" \
                --arg model "$MODEL" \
                --arg err "$gemini_output" \
                '{
                    consilium_id: $cid,
                    run: ($run | tonumber),
                    status: "cli_error",
                    model: $model,
                    error_excerpt: ($err | .[:500])
                }' > "$out_file"
            sleep "$SLEEP_BETWEEN"
            continue
        fi

        if extracted=$(extract_response "$gemini_output"); then
            echo "$extracted" | jq \
                --arg cid "$cid" \
                --arg run "$run" \
                --arg model "$MODEL" \
                '{
                    consilium_id: $cid,
                    run: ($run | tonumber),
                    status: "ok",
                    model: $model,
                    response: .response,
                    stats: .stats
                }' > "$out_file"
            rm -f "$raw_file"
            echo "    OK"
        else
            echo "    PARSE-FEHLER: siehe $(basename "$raw_file")"
            jq -n \
                --arg cid "$cid" \
                --arg run "$run" \
                --arg model "$MODEL" \
                --arg raw "$gemini_output" \
                '{
                    consilium_id: $cid,
                    run: ($run | tonumber),
                    status: "parse_error",
                    model: $model,
                    raw_excerpt: ($raw | .[:1000])
                }' > "$out_file"
        fi

        sleep "$SLEEP_BETWEEN"
    done
done

echo ""
echo "[$(date +%H:%M:%S)] FERTIG. Outputs in: $OUTPUT_DIR"
echo ""
echo "Status-Übersicht:"
echo "  ok:           $(grep -l '"status": "ok"' "$OUTPUT_DIR"/*.json 2>/dev/null | wc -l)"
echo "  parse_error:  $(grep -l '"status": "parse_error"' "$OUTPUT_DIR"/*.json 2>/dev/null | wc -l)"
echo "  cli_error:    $(grep -l '"status": "cli_error"' "$OUTPUT_DIR"/*.json 2>/dev/null | wc -l)"
