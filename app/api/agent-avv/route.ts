import { NextRequest, NextResponse } from "next/server";
import { Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";

// Wichtig: Node-Runtime (kein Edge)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- Hilfsfunktion: PDF -> Text (optional) ---
async function pdfToText(file: File): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default as any;
  const buf = Buffer.from(await file.arrayBuffer());
  const res = await pdfParse(buf).catch(() => null);
  if (!res || !res.text || !res.text.trim()) {
    throw new Error("PDF-Text leer oder nicht lesbar");
  }
  return res.text;
}

// --- Deinen Agent aus dem SDK exakt wie vorgegeben aufsetzen ---
const avvCheckAgent = new Agent({
  name: "AVV-Check-Agent",
  instructions:
    "Prüft Auftragsverarbeitungsverträge (AVVs) automatisiert auf DSGVO-Konformität gemäß Art. 28 Abs. 3 DSGVO und erstellt strukturierte Risikoanalysen.",
  model: "gpt-5-chat-latest",
  modelSettings: {
    temperature: 0.3,
    topP: 1,
    maxTokens: 2048,
    store: true,
  },
});

// Hybrid-Ausgabe → JSON extrahieren (Agent gibt zuerst Kurzbericht, danach JSON)
function extractJsonBlock(output: string): any {
  // Schneidet Codefences weg, falls vorhanden
  const cleaned = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  // Versuche, den letzten {...}-Block zu finden (robust bei vorgeschaltetem Kurzbericht)
  const start = cleaned.lastIndexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Weiter unten noch eine generische Fehlermeldung
    }
  }
  // Fallback: evtl. ist es reines JSON
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Konnte keinen gültigen JSON-Block aus der Agent-Antwort extrahieren.");
  }
}

// POST /api/agent-avv
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData().catch(() => null);

    // Entweder Datei (PDF) oder Text akzeptieren
    let inputText = "";
    if (form) {
      const file = form.get("file") as File | null;
      const text = form.get("text") as string | null;

      if (file && file.type?.includes("pdf")) {
        inputText = await pdfToText(file);
      } else if (text && typeof text === "string" && text.trim()) {
        inputText = text.trim();
      }
    } else {
      // JSON body mit { text: "..." } unterstützen
      const json = await req.json().catch(() => null);
      if (json?.text && typeof json.text === "string") {
        inputText = json.text.trim();
      }
    }

    if (!inputText) {
      return NextResponse.json(
        { error: "Kein Text und keine PDF übergeben." },
        { status: 400 }
      );
    }

    // ---- Agent ausführen (entspricht deinem SDK-Beispiel) ----
    const conversationHistory: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: inputText }] },
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text:
              `Rolle Du bist ein AVV-Prüfassistent. Prüfe hochgeladene Auftragsverarbeitungsverträge (AVV / DPA) auf DSGVO-Konformität gemäß Art. 28 Abs. 3 DSGVO und erstelle strukturierte Risiko- und Maßnahmenanalysen.
Verhalten
Lies hochgeladene Dateien (PDF, DOCX, TXT) automatisch ein.
Extrahiere relevante Passagen und prüfe systematisch folgende Kernpunkte:
Weisungsrecht („nur auf dokumentierte Weisung“)
Vertraulichkeit
Technische / organisatorische Maßnahmen (TOMs)
Sub-Prozessoren / Genehmigung
Unterstützung bei Betroffenenrechten
Unterstützung bei Datenschutzverletzungen (Art. 33/34)
Löschung / Rückgabe nach Vertragsende
Nachweise / Audit
Erweiterte Kriterien: Internationale Übermittlungen / SCCs, Haftungsbegrenzung, Gerichtsstand.
Ausgabeformat (Hybrid-Antwort) Teil 1: Kurzbericht für Menschen (max. 10 Zeilen) Teil 2: JSON-Struktur mit:
{   "contract_metadata": {"title": "...", "date": "...", "parties": [...]},   "risk_score": {"overall": 0–100, "rationale": "..."},   "findings": {"art_28": {...}, "additional_clauses": {...}},   "actions": [{"severity": "...", "issue": "...", "suggested_clause": "..."}] }
Richtlinien:
Antworte zuerst mit einer menschlich verständlichen Zusammenfassung (deutsch, kompakt, klar).
Danach folgt der vollständige JSON-Block.
Keine anderen Texte außerhalb dieser Struktur.
Wenn kein Dokument hochgeladen wurde, erkläre das kurz und liefere Dummy-JSON mit "missing".`,
          },
        ],
      },
    ];

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_local_vercel_proxy",
      },
    });

    const result = await withTrace("AVV-Check-Agent", async () => {
      return runner.run(avvCheckAgent, conversationHistory);
    });

    if (!result?.finalOutput) {
      return NextResponse.json(
        { error: "Agent lieferte keine Ausgabe." },
        { status: 502 }
      );
    }

    // JSON-Teil extrahieren und zurückgeben
    const json = extractJsonBlock(result.finalOutput);
    return NextResponse.json(json);
  } catch (e: any) {
    return NextResponse.json(
      { error: "Agent-Serverfehler", details: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}