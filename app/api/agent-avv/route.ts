import { NextRequest, NextResponse } from "next/server";
import { Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";

// WICHTIG: Node-Runtime (kein Edge)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Polyfill für Node: pdfjs (indirekt via pdf-parse) erwartet DOMMatrix */
function ensureDomMatrix() {
  if (typeof (globalThis as any).DOMMatrix === "undefined") {
    (globalThis as any).DOMMatrix = class {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      rotate() { return this; }
      invertSelf() { return this; }
      toFloat32Array() { return new Float32Array([this.a, this.b, this.c, this.d, this.e, this.f]); }
      toFloat64Array() { return new Float64Array([this.a, this.b, this.c, this.d, this.e, this.f]); }
    };
  }
}

/** PDF -> Text mit pdf-parse (lazy import NACH Polyfill) */
async function pdfToText(file: File): Promise<string> {
  ensureDomMatrix();

  // Einige pdfjs-Bugs umgehen (kein Worker in Node)
  (process as any).env.PDFJS_DISABLE_CREATEOBJECTURL = "true";
  (process as any).env.PDFJS_WORKER_DISABLE = "true";

  const pdfParse = (await import("pdf-parse")).default as any; // lazy, nachdem DOMMatrix existiert
  const buf = Buffer.from(await file.arrayBuffer());
  const res = await pdfParse(buf).catch((err: any) => {
    throw new Error(`PDF konnte nicht gelesen werden: ${err?.message || String(err)}`);
  });

  const text = (res?.text || "").trim();
  if (!text) throw new Error("PDF-Text leer oder nicht lesbar");
  return text;
}

/* ------------------------------------------------------------
   Agent-Konfiguration (exakt wie SDK-Vorlage)
------------------------------------------------------------- */
const avvCheckAgent = new Agent({
  name: "AVV-Check-Agent",
  instructions:
    "Prüft Auftragsverarbeitungsverträge (AVVs) automatisiert auf DSGVO-Konformität gemäß Art. 28 Abs. 3 DSGVO und erstellt strukturierte Risikoanalysen.",
  model: "gpt-5-chat-latest",
  modelSettings: { temperature: 0.3, topP: 1, maxTokens: 2048, store: true },
});

/* ------------------------------------------------------------
   JSON aus Agent-Antwort extrahieren
------------------------------------------------------------- */
function extractJsonBlock(output: string): any {
  const cleaned = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.lastIndexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      /* ignore */
    }
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Konnte keinen gültigen JSON-Block aus der Agent-Antwort extrahieren.");
  }
}

/* ------------------------------------------------------------
   POST /api/agent-avv
------------------------------------------------------------- */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData().catch(() => null);
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
      const json = await req.json().catch(() => null);
      if (json?.text && typeof json.text === "string") inputText = json.text.trim();
    }

    if (!inputText) {
      return NextResponse.json({ error: "Kein Text und keine PDF übergeben." }, { status: 400 });
    }

    // ---- Agent ausführen (entspricht SDK-Beispiel) ----
    const conversationHistory: AgentInputItem[] = [
  {
    role: "user",
    content: [{ type: "input_text", text: inputText }],
    status: "completed",
  },
  {
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: `Rolle Du bist ein AVV-Prüfassistent. Prüfe hochgeladene Auftragsverarbeitungsverträge (AVV / DPA) auf DSGVO-Konformität gemäß Art. 28 Abs. 3 DSGVO und erstelle strukturierte Risiko- und Maßnahmenanalysen.
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
{ "contract_metadata": {"title": "...", "date": "...", "parties": [...]}, "risk_score": {"overall": 0–100, "rationale": "..."}, "findings": {"art_28": {...}, "additional_clauses": {...}}, "actions": [{"severity": "...", "issue": "...", "suggested_clause": "..."}] }
Richtlinien:
Antworte zuerst mit einer menschlich verständlichen Zusammenfassung (deutsch, kompakt, klar).
Danach folgt der vollständige JSON-Block.
Keine anderen Texte außerhalb dieser Struktur.
Wenn kein Dokument hochgeladen wurde, erkläre das kurz und liefere Dummy-JSON mit "missing".`,
      },
    ],
    status: "completed", // <- NEU
  },
];

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_local_vercel_proxy",
      },
    });

    const result = await withTrace("AVV-Check-Agent", async () =>
      runner.run(avvCheckAgent, conversationHistory)
    );

    if (!result?.finalOutput) {
      return NextResponse.json({ error: "Agent lieferte keine Ausgabe." }, { status: 502 });
    }

    const json = extractJsonBlock(result.finalOutput);
    return NextResponse.json(json);
  } catch (e: any) {
    return NextResponse.json(
      { error: "Agent-Serverfehler", details: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}