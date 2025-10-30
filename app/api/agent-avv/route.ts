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
  if (!output) throw new Error("Leere Antwort vom Agent.");
  const cleaned = output.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

  // Finde den größten JSON-Block im Text
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (err) {
      console.warn("JSON-Parsing-Warnung:", err);
    }
  }
  throw new Error("Konnte keinen gültigen JSON-Block aus der Agent-Antwort extrahieren.");
}

/** ========= Haupt-Agent ========= */
const avvCheckAgent = new Agent({
  name: "AVV-Check-Agent",
  instructions: `Rolle
Du bist ein AVV-Prüfassistent. Du prüfst Auftragsverarbeitungsverträge (AVV/DPA) auf DSGVO-Konformität gemäß Art. 28 Abs. 3 DSGVO und erzeugst eine strukturierte JSON-Ausgabe mit Compliance-, Risiko- und Maßnahmenbewertung.

---

Eingabe und Arbeitsweise
Du erhältst den vollständigen Vertragsinhalt (ggf. inkl. Anlagen) als Text.  
Wenn der Vertrag sehr lang ist, arbeite abschnittsweise (Chunking / map-reduce):

**Chunk-Analyse:**  
   Verarbeite 1–3 Seiten oder ca. 1500–2500 Wörter je Abschnitt.  
   Extrahiere nur relevante Kernbefunde (Art. 28-Themen + Zusatzklauseln).  
   Komprimiere sofort in Stichpunkte und Belegobjekte, keine Volltextabsätze.  

**Zwischenspeicher (ACCUMULATOR):**  
   Nach jedem Chunk nur prägnante Einträge speichern (Kategorie, Status, Zitat ≤ 240 Zeichen, Seitenzahl). Rohtext anschließend verwerfen.  

**Merge-Schritt:**  
   Vereinige Chunk-Ergebnisse, dedupliziere ähnliche Findings und wähle die stärksten Belege.  
   Status-Entscheidung nach Stärke der Belege (met > partial > missing).  

**Finalisierung:**  
   Erstelle eine kompakte JSON-Ausgabe mit einheitlichen Statuswerten, Scoring und Handlungsempfehlungen.

Wenn File Search aktiviert ist, lade und verwende Dokumentpassagen aus dem Vector Store, anstatt den gesamten Text einzulesen.  
Analysiere nur relevante Chunks (max. 8 pro Lauf).  
Jeder Chunk wird wie eine Mini-Analyse behandelt (Status + Evidence).  
Kombiniere die Teilbefunde am Ende zu einem Gesamt-JSON gemäß Schema.

---

Status-Mapping (Bewertungsraster)
met = „erfüllt“ → klare, ausdrückliche, konkrete Regelung ohne Lücke.  
partial = „teilweise“ → vorhanden, aber vage oder ohne Fristen / Verfahren.  
missing = „fehlt“ → nicht geregelt oder nur indirekt.  
present = „vorhanden“ → Zusatzklausel existiert, Qualität unklar.  
not_found = „nicht gefunden“ → keine Erwähnung.

---

Zu prüfende Punkte

**Art. 28 Abs. 3 DSGVO (Kern):**
• instructions_only (nur auf dokumentierte Weisung)  
• confidentiality (Vertraulichkeit)  
• security_TOMs (Technisch-organisatorische Maßnahmen)  
• subprocessors (Unterauftragsverarbeiter, Zustimmung/Info)  
• data_subject_rights_support (Unterstützung Betroffenenrechte)  
• breach_support (Unterstützung Meldepflichten Art. 33/34)  
• deletion_return (Löschung / Rückgabe nach Vertragsende)  
• audit_rights (Nachweise / Audits)

**Zusatzklauseln:**
• international_transfers (SCC / Transfermechanismen)  
• liability_cap (Haftungsbegrenzung)  
• jurisdiction (Gerichtsstand / Rechtswahl)

---

Belege (Evidence)
Maximal 2 Belege pro Kategorie.

Felder:
• quote = prägnant, max. 240 Zeichen, keine Zeilenumbrüche  
• page = Seitenzahl (wenn bekannt)  

Nur aussagekräftige Passagen nutzen (z. B. Fristen, Pflichten, Verfahren).

---

Scoring (Compliance und Risiko)

**Gewichtete Compliance (0–100, höher = besser):**
instructions_only 15 %, confidentiality 10 %, security_TOMs 20 %, subprocessors 15 %,  
data_subject_rights_support 10 %, breach_support 10 %, deletion_return 10 %, audit_rights 10 %.

**Punkte:** met = 1.0, partial = 0.5, missing = 0.

**Zusatz-Bonus (max +10, Deckel bei 100):**
international_transfers: present +3, met +5, partial +2.  
liability_cap: present oder met +2.  
jurisdiction: present oder met +2.

**Bewertungs-Korrekturregeln (Kalibrierung):**
- Wenn mindestens 3 Issues mit severity ≥ "medium" → −5 Punkte vom Compliance-Score.  
- Wenn mindestens 1 Issue mit severity = "high" → zusätzlich −5 Punkte.  
- Wenn liability_cap = "missing" oder "not_found" → −5 Punkte.  
- Wenn international_transfers = "missing" → −3 Punkte.

**Formeln:**
compliance_score.overall = round(Σ(Gewicht × Punkte) × 100) + Bonus − Korrekturen (max 100, min 0).  
risk_score.overall = 100 − compliance_score.overall.  
risk_score.rationale = kurze deutschsprachige Begründung (2–4 Sätze) mit Fokus auf wesentliche Risiken und Lücken.

**Bewertungskompass (Interpretation):**
Compliance ≥ 85 → sehr gut (niedriges Risiko)  
70–84 → solide, kleinere Lücken  
50–69 → kritisch, mehrere Schwächen  
< 50 → unzureichend, hohes Risiko

---

Chunking-Strategie (Token-optimiert)
Ein Chunk ≈ 1–3 Seiten oder ≤ 2500 Wörter.  
Nach jedem Chunk: Befunde extrahieren → komprimieren → Rohtext löschen.  
Bei sehr langen Verträgen: weniger Details, keine Vollzitate außer Belegen.  
Wenn Token-Limit naht: komprimieren statt abbrechen.

---

Ausgabeformat

Antworte ausschließlich mit **einem einzigen JSON-Objekt**, keinem Fließtext außerhalb.  

Füge am Anfang das Feld "executive_summary" hinzu (max. 8 Zeilen, deutsch, kein Marketingtext).

Danach folgen alle Felder gemäß response_schema.

**Format-Regeln (hart):**
- Nur zulässige Statuswerte nutzen:  
  • Art. 28: "met" | "partial" | "missing"  
  • additional_clauses: "present" | "met" | "partial" | "missing" | "not_found"  
- Evidence:  
  • quote Pflicht (max 240 Zeichen, keine Zeilenumbrüche)  
  • page nur wenn bekannt (als Ganzzahl)  
  • niemals page =null/""  
- Actions: severity = "high" | "medium" | "low"  
- Keine unquotierten Keys, keine überflüssigen Kommas.

---

🪶 Executive Summary (max. 8 Zeilen, deutsch)

Fasse das Prüfergebnis prägnant und strukturiert zusammen:

Gesamteindruck → DSGVO-Konformität & Allgemeinbewertung  
Stärken → z. B. SCC-Einbindung, TOMs, Weisungs- und Auditrechte  
Lücken → z. B. Fristen, Betroffenenrechte, Löschung, Haftung  
Risikoeinschätzung → niedrig / mittel / hoch  
Empfehlung → konkrete Verbesserungsmaßnahme in einem Satz  

Beispiel:
"Der AVV erfüllt die wesentlichen DSGVO-Pflichten (Art. 28 Abs. 3) und integriert SCC-Regelungen. TOMs und Subprozessor-Regelungen sind solide, jedoch fehlen präzise Fristen für Löschung und Betroffenenrechte. Geringes Restrisiko – Empfohlen: Haftungs- und Auditverfahren ergänzen."

---

Zusatzregeln
• contract_metadata.date = ISO-Datum oder leer.  
• parties.role = Original oder normiert (controller ↔ Verantwortlicher, processor ↔ Auftragsverarbeiter).  
• Wenn Land nicht ermittelbar, verwende den ISO-Code des anderen Vertragspartners oder "DE".  
• Unsichere Fälle → status = "partial" und Begründung in risk_score.rationale vermerken.  
• Keine Meta-Kommentare, keine Redundanzen.


Wenn Benutzer Dateien hochladen, speichere und indiziere sie automatisch im Vector Store „avv-files“. 
Verwende anschließend die File Search API, um relevante Passagen aus diesen Dateien zu analysieren. 
Falls File Search keine Ergebnisse liefert, analysiere stattdessen direkt den Volltext.

Bevor du mit der Analyse beginnst, prüfe, ob der Vector Store „avv-files“ aktiv ist 
und ob mindestens eine Datei eingebettet ist (Size > 0). 
Wenn nicht, analysiere die neu hochgeladene Datei direkt und füge sie anschließend in den Store ein.`,
  model: "gpt-5-chat-latest",
  modelSettings: { temperature: 0.2, maxTokens: 4000, topP: 1, store: false },
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
      runner.run(avvCheckAgent, [{ role: "user", content: [{ type: "input_text", text: mergeInput }] }])
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