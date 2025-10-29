import { NextRequest, NextResponse } from "next/server";
import { Agent, run } from "@openai/agents";

// Wichtig: Node-Runtime (kein Edge)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- PDF -> Text (robust, ohne pdfjs) ---
async function pdfToText(file: File): Promise<string> {
  // pdf-parse hat ein Default-Export
  const pdfParse = (await import("pdf-parse")).default as any;
  const buf = Buffer.from(await file.arrayBuffer());
  const res = await pdfParse(buf).catch(() => null);
  if (!res || !res.text || !res.text.trim()) {
    throw new Error("PDF-Text leer oder nicht lesbar");
  }
  return res.text;
}

// --- OpenAI Agent ---
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

// Hybrid-Ausgabe → JSON extrahieren (Agent gibt häufig erst Kurzbericht, dann JSON)
function extractJsonBlock(output: string): any {
  const cleaned = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.lastIndexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  try { return JSON.parse(cleaned); } catch {
    throw new Error("Konnte keinen gültigen JSON-Block aus der Agent-Antwort extrahieren.");
  }
}

// POST /api/agent-avv
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
      if (json?.text && typeof json.text === "string") {
        inputText = json.text.trim();
      }
    }

    if (!inputText) {
      return NextResponse.json({ error: "Kein Text und keine PDF übergeben." }, { status: 400 });
    }

    // Ein einfacher Prompt, der die Agent-„Hybrid“-Antwort (Kurzbericht + JSON) erzwingt
    const prompt = `
Rolle
Du bist ein AVV-Prüfassistent. Prüfe den folgenden AVV-Text auf DSGVO-Konformität (Art. 28 Abs. 3) und liefere am Ende einen JSON-Block.

Prüfkategorien (Kernauszug):
- Weisungsrecht (“nur auf dokumentierte Weisung”)
- Vertraulichkeit
- Technische/organisatorische Maßnahmen (TOMs)
- Sub-Prozessoren/Genehmigung
- Unterstützung Betroffenenrechte
- Unterstützung bei Datenschutzverletzungen (Art. 33/34)
- Löschung/Rückgabe nach Vertragsende
- Nachweise/Audit
Erweiterte Kriterien:
- Internationale Übermittlungen/SCCs
- Haftungsbegrenzung
- Gerichtsstand/Rechtswahl

Ausgabeformat (Hybrid):
1) Sehr kurze Zusammenfassung (deutsch, max. 10 Zeilen).
2) Danach **nur** folgenden JSON-Block:
{
  "contract_metadata": {"title": "...", "date": "...", "parties": [{"role": "...", "name": "...", "country": "..."}]},
  "findings": {
    "art_28": {
      "instructions_only": {"status": "met|partial|missing", "evidence": [{"quote": "...", "page": 1}]},
      "confidentiality": {"status": "...", "evidence": []},
      "security_TOMs": {"status": "...", "evidence": []},
      "subprocessors": {"status": "...", "evidence": []},
      "data_subject_rights_support": {"status": "...", "evidence": []},
      "breach_support": {"status": "...", "evidence": []},
      "deletion_return": {"status": "...", "evidence": []},
      "audit_rights": {"status": "...", "evidence": []}
    },
    "additional_clauses": {
      "international_transfers": {"status": "present|partial|not_found|missing", "evidence": []},
      "liability_cap": {"status": "present|partial|not_found|missing", "evidence": []},
      "jurisdiction": {"status": "present|partial|not_found|missing", "evidence": []}
    }
  },
  "risk_score": {"overall": 0-100, "rationale": "..."},
  "actions": [{"severity": "high|medium|low", "issue": "...", "suggested_clause": "..."}]
}

Wichtige Regeln:
- Zitiere Belege mit kurzer Quote und (falls ersichtlich) Seitenzahl.
- JSON **muss** valide sein, keine Kommentare/kein zusätzliches Markdown.

Zu prüfender Vertragstext:
${inputText}
    `.trim();

    const result = await run(avvCheckAgent, prompt);

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