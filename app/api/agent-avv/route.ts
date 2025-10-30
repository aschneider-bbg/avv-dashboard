import { NextRequest, NextResponse } from "next/server";
import { Agent, Runner, withTrace } from "@openai/agents";
import pdf from "pdf-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ========= PDF → Text  ========= */
async function pdfToText(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  const data = await pdf(buf).catch(() => null);
  if (!data || !data.text?.trim()) throw new Error("PDF-Text leer oder nicht lesbar.");
  // leichte Normalisierung
  let text = data.text
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

/** ========= Token-Schätzung (grob) =========
 * GPT-5/4.1 grob ~ 4 Zeichen pro Token. Wir arbeiten mit Zeichenlimits. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** ========= Semantischer Chunker =========
 * - Split nach starken Grenzen (Überschriften, Artikel/Paragraphen, Anhang)
 * - Dann nach Absätzen
 * - Chunk-Zusammenbau bis targetTokens, Hard-Cap bei hardMaxTokens
 */
function semanticChunkText(
  text: string,
  targetTokens = 8_000,   // ≈ 32k Zeichen
  hardMaxTokens = 9_500   // ≈ 38k Zeichen, knapp unterm 10k-Block
): string[] {
  const strongDelim = new RegExp(
    [
      // Deutsche Überschriften/Strukturmarker
      String.raw`(?=^.{0,6}(?:Kapitel|Abschnitt|Artikel|Art\.|§|Ziffer|Anhang)\b)`,
      // Nummerierte Hauptpunkte
      String.raw`(?=^\s*(?:[IVXLC]+\.)\s)`,
      String.raw`(?=^\s*(?:\d{1,2}\.)\s)`,
      // fette/trennzeilenartige Überschriften
      String.raw`(?=^\s*[A-ZÄÖÜ][A-ZÄÖÜ \-/]{5,}\s*$)`,
    ].join("|"),
    "m"
  );

  // 1) Vorsegmentierung an starken Grenzen
  let blocks = text.split(strongDelim).map(s => s.trim()).filter(Boolean);

  // Fallback: wenn kaum starke Grenzen gefunden → große Blöcke = gesamter Text
  if (blocks.length <= 1) {
    blocks = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  }

  // 2) Feiner: Große Blöcke noch an Absatzgrenzen teilen
  const refined: string[] = [];
  for (const b of blocks) {
    if (estimateTokens(b) <= hardMaxTokens) {
      refined.push(b);
    } else {
      // Absatzweise splitten
      const paras = b.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
      let buf: string[] = [];
      let bufTokens = 0;
      for (const p of paras) {
        const t = estimateTokens(p) + 2; // +2 für Absatztrenner
        if (bufTokens + t > targetTokens && buf.length) {
          refined.push(buf.join("\n\n"));
          buf = [p];
          bufTokens = estimateTokens(p);
        } else if (t > hardMaxTokens) {
          // Extrem langer Absatz → hart schneiden
          const chunks = hardSplitByChars(p, hardMaxTokens * 4); // *4 → Zeichen
          refined.push(...chunks);
          buf = [];
          bufTokens = 0;
        } else {
          buf.push(p);
          bufTokens += t;
        }
      }
      if (buf.length) refined.push(buf.join("\n\n"));
    }
  }

  // 3) Merge benachbarter Mini-Blöcke (zu klein)
  const MIN_TOK = 1_000;
  const merged: string[] = [];
  let cursor = "";
  let curTok = 0;
  for (const seg of refined) {
    const t = estimateTokens(seg);
    if (!cursor) {
      cursor = seg;
      curTok = t;
      continue;
    }
    if (curTok < MIN_TOK && curTok + t <= hardMaxTokens) {
      cursor = cursor + "\n\n" + seg;
      curTok += t;
    } else {
      merged.push(cursor);
      cursor = seg;
      curTok = t;
    }
  }
  if (cursor) merged.push(cursor);

  return merged;
}

/** Hartes Zeichen-Splitting falls ein Absatz zu groß ist */
function hardSplitByChars(s: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += maxChars) {
    out.push(s.slice(i, i + maxChars));
  }
  return out;
}

/** ========= JSON aus Agent-Output extrahieren ========= */
function extractJson(output: string): any {
  const cleaned = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  // Letzten JSON-Block nehmen (Hybrid-Output: Bericht + JSON)
  const start = cleaned.lastIndexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  // Fallback: mancher Agent liefert reines JSON
  try { return JSON.parse(cleaned); } catch {}
  throw new Error("Konnte keinen gültigen JSON-Block aus der Agent-Antwort extrahieren.");
}

/** ========= Haupt-Agent ========= */
const avvCheckAgent = new Agent({
  name: "AVV-Check-Agent",
  instructions: `Du prüfst Auftragsverarbeitungsverträge (AVV / DPA) auf DSGVO-Konformität (Art. 28 Abs. 3 DSGVO).
Antworte *immer* mit Hybrid-Output: zuerst Kurzbericht (DE), danach reiner JSON-Block im Format:
{
 "contract_metadata": {"title": "...", "date": "...", "parties": [...]},
 "findings": {"art_28": {...}, "additional_clauses": {...}},
 "risk_score": {"overall": 0–100, "rationale": "..."},
 "actions": [{"severity":"...", "issue":"...", "suggested_clause":"..."}]
}`,
  model: "gpt-5-chat-latest",
  modelSettings: { temperature: 0.2, maxTokens: 1800, topP: 1, store: false },
});

/** ========= Merge-Agent ========= */
const mergeAgent = new Agent({
  name: "AVV-Merge-Agent",
  instructions: `Du erhältst mehrere JSON-Ergebnisse aus Teilanalysen eines AVV.
Führe sie *verlustfrei* zu einem konsistenten Gesamt-JSON im gleichen Format zusammen.
Konsolidiere widersprüchliche Status (met/partial/missing bzw. erfüllt/teilweise/fehlt) sinnvoll.`,
  model: "gpt-5-chat-latest",
  modelSettings: { temperature: 0, maxTokens: 2048 },
});

/** ========= POST ========= */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData().catch(() => null);
    let inputText = "";

    if (form) {
      const file = form.get("file") as File | null;
      const text = (form.get("text") as string | null)?.trim();
      if (file && file.type?.includes("pdf")) inputText = await pdfToText(file);
      else if (text) inputText = text;
    } else {
      const json = await req.json().catch(() => null);
      inputText = json?.text?.trim() ?? "";
    }

    if (!inputText) {
      return NextResponse.json({ error: "Kein Text übergeben." }, { status: 400 });
    }

    // ====== Semantisches Chunking ======
    const chunks = semanticChunkText(inputText, 8_000, 9_500);

    const runner = new Runner();
    const partialResults: any[] = [];

    // ====== Chunk-Analyse mit Backoff ======
    for (let i = 0; i < chunks.length; i++) {
      const input = `Teil ${i + 1}/${chunks.length}:\n\n${chunks[i]}`;
      const res = await withTrace(`chunk-${i + 1}`, async () =>
        runWithBackoff(() =>
          runner.run(avvCheckAgent, [{ role: "user", content: [{ type: "input_text", text: input }] }])
        )
      );
      if (res?.finalOutput) {
        const parsed = extractJson(res.finalOutput);
        partialResults.push(parsed);
      }
    }

    // ====== Zusammenführung ======
    const mergeInput =
      `Hier sind ${partialResults.length} JSON-Ergebnisse aus AVV-Teilanalysen.\n` +
      `Fasse sie zu einem konsistenten Gesamt-JSON im gleichen Format zusammen.\n\n` +
      JSON.stringify(partialResults, null, 2);

    const merged = await runWithBackoff(() =>
      runner.run(mergeAgent, [{ role: "user", content: [{ type: "input_text", text: mergeInput }] }])
    );

    if (!merged?.finalOutput) {
        throw new Error("Merge-Agent lieferte keine finale Ausgabe.");
    }
    const finalJson = extractJson(merged.finalOutput);
    return NextResponse.json(finalJson);
  } catch (e: any) {
    return NextResponse.json(
      { error: "Agent-Serverfehler", details: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}

/** ========= Exponentielles Backoff für TPM/Ratenfehler ========= */
async function runWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let delay = 800;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message || err);
      const isRateLimit =
        /too_many_requests|rate limit|tokens per min|tpm|overloaded/i.test(msg) ||
        err?.code === "too_many_requests";

      if (!isRateLimit || attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2; // Exponential
    }
  }
  // Unreachable
  throw new Error("Backoff failed.");
}