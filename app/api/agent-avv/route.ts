import { NextRequest, NextResponse } from "next/server";
import { Agent, run } from "@openai/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- PDF -> Text (ohne pdfjs) ---
async function pdfToText(file: File): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default as any;
  const buf = Buffer.from(await file.arrayBuffer());
  const res = await pdfParse(buf).catch(() => null);
  if (!res || !res.text || !res.text.trim()) {
    throw new Error("PDF-Text leer oder nicht lesbar");
  }
  return res.text;
}

// --- Agent ---
const avvCheckAgent = new Agent({
  name: "AVV-Check-Agent",
  instructions:
    "Prüft Auftragsverarbeitungsverträge (AVVs) automatisiert auf DSGVO-Konformität gemäß Art. 28 Abs. 3 DSGVO und erstellt strukturierte Risikoanalysen.",
  model: "gpt-5-chat-latest",
  modelSettings: {
    temperature: 0,     // strikt für deterministischere JSON-Ausgabe
    topP: 1,
    maxTokens: 2048,
    store: false,
  },
});

/** Robuster JSON-Extractor:
 *  1) Sucht ```json fenced code.
 *  2) Sucht ersten '{' und läuft mit Klammer-Balancing (beachtet Strings/Escapes).
 *  3) Letzter Versuch: kleine Bereinigung (BOM, Smartquotes, trailing commas).
 */
function extractJsonBlock(output: string): any {
  const text = (output ?? "").trim();

  // 1) Fenced JSON: ```json ... ```
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const fenced = fenceMatch[1].trim();
    try { return JSON.parse(fenced); } catch { /* fallback below */ }
  }

  // 2) Klammer-Balancing ab erstem '{'
  const start = text.indexOf("{");
  if (start !== -1) {
    let i = start, depth = 0, inStr = false, esc = false;
    const s = text;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) { esc = false; }
        else if (ch === "\\") { esc = true; }
        else if (ch === "\"") { inStr = false; }
      } else {
        if (ch === "\"") inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = s.slice(start, i + 1);
            try { return JSON.parse(candidate); } catch {
              // 3) sanfte Bereinigung und zweiter Parse-Versuch
              const cleaned = cleanJson(candidate);
              return JSON.parse(cleaned);
            }
          }
        }
      }
    }
  }

  // 3) Letzter Versuch: kompletten Text säubern und parsen
  const cleanedAll = cleanJson(text);
  try { return JSON.parse(cleanedAll); } catch {
    throw new Error("Konnte keinen gültigen JSON-Block aus der Agent-Antwort extrahieren.");
  }
}

function cleanJson(s: string): string {
  let t = s;
  // BOM entfernen
  t = t.replace(/^\uFEFF/, "");
  // „smarte“ Anführungszeichen -> normale
  t = t.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'");
  // trailing commas entfernen ( ,}  oder ,] )
  t = t.replace(/,\s*([}\]])/g, "$1");
  // Codefences, falls noch drin
  t = t.replace(/```json|```/g, "");
  return t.trim();
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

    // WICHTIG: JSON-ONLY Prompt, keine Kurzsummary mehr
    const prompt = `
Liefere **AUSSCHLIESSLICH** einen gültigen JSON-Block (kein Markdown, keine Erklärungen, keine Summary, keine Fences).
Schema:
{
  "contract_metadata": {"title": "...", "date": "...", "parties": [{"role": "...", "name": "...", "country": "..."}]},
  "findings": {
    "art_28": {
      "instructions_only": {"status": "met|partial|missing", "evidence": [{"quote": "...", "page": 1}]},
      "confidentiality": {"status": "met|partial|missing", "evidence": []},
      "security_TOMs": {"status": "met|partial|missing", "evidence": []},
      "subprocessors": {"status": "met|partial|missing", "evidence": []},
      "data_subject_rights_support": {"status": "met|partial|missing", "evidence": []},
      "breach_support": {"status": "met|partial|missing", "evidence": []},
      "deletion_return": {"status": "met|partial|missing", "evidence": []},
      "audit_rights": {"status": "met|partial|missing", "evidence": []}
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
Regeln:
- Gib NUR den JSON-Block zurück (beginnt mit { und endet mit }).
- Die JSON-Syntax MUSS valide sein (keine Kommentare, keine nachgestellten Kommas).
- Zitiere Belege mit kurzer "quote" und – falls ersichtlich – "page" (Zahl).
Text zur Prüfung:
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