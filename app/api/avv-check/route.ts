import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------------- Prompt (Deutsch) ---------------- */
const SYSTEM_PROMPT = `
Du bist ein AVV-Analyst. Lies den Vertragstext (Seiten sind mit "Seite N:" markiert) und gib AUSSCHLIESSLICH valides JSON zurück:

{
  "vertrag_metadata": {
    "titel": "...",
    "datum": "...",
    "parteien": [ { "rolle": "...", "name": "...", "land": "..." } ]
  },
  "prüfung": {
    "art_28": {
      "weisung": { "status": "erfüllt|teilweise|fehlt", "belege": [ { "page": 1, "quote": "..." } ] },
      "vertraulichkeit": { "status": "erfüllt|teilweise|fehlt", "belege": [] },
      "toms": { "status": "erfüllt|teilweise|fehlt", "belege": [] },
      "unterauftragsverarbeiter": { "status": "erfüllt|teilweise|fehlt", "belege": [] },
      "betroffenenrechte": { "status": "erfüllt|teilweise|fehlt", "belege": [] },
      "vorfallmeldung": { "status": "erfüllt|teilweise|fehlt", "belege": [] },
      "löschung_rückgabe": { "status": "erfüllt|teilweise|fehlt", "belege": [] },
      "audit_nachweis": { "status": "erfüllt|teilweise|fehlt", "belege": [] }
    },
    "zusatzklauseln": {
      "internationale_übermittlungen": { "status": "erfüllt|teilweise|fehlt|vorhanden|nicht gefunden", "belege": [] },
      "haftungsbegrenzung": { "status": "erfüllt|teilweise|fehlt|vorhanden|nicht gefunden", "belege": [] },
      "gerichtsstand_recht": { "status": "erfüllt|teilweise|fehlt|vorhanden|nicht gefunden", "belege": [] }
    }
  },
  "risk_rationale": "1–3 Sätze Executive Summary auf Deutsch."
}

Vorgaben:
- Exakt diese Feldnamen verwenden.
- Status nur aus dem genannten Vokabular.
- Belege IMMER mit "page" (entspricht der 'Seite N' im Text) und kurzem "quote".
- Kein Markdown, keine Prosa außerhalb des JSON.
- Wenn Hinweise (Seitenlisten) vorhanden sind, nutze sie gezielt zur Belegsuche.
`;

/* ---------- Keyword-Lexikon je Kategorie (für Hinweise an das Modell) ---------- */
const KEYWORDS: Record<string, string[]> = {
  weisung: [
    "Weisung", "Weisungen", "dokumentierte Weisung", "auf Weisung", "Instruktion", "Instruction",
  ],
  vertraulichkeit: [
    "Vertraulichkeit", "Verschwiegenheit", "Geheimhaltung", "Geheimnis", "Non-Disclosure",
    "Datengeheimnis", "Confidentiality",
  ],
  toms: [
    "Technisch-organisatorische", "TOM", "TOMs", "Stand der Technik", "Sicherheitsmaßnahme", "ISO 27001",
    "Privacy by Design", "Privacy by Default",
  ],
  unterauftragsverarbeiter: [
    "Unterauftragsverarbeiter", "Subunternehmer", "Subprozessor", "Unterauftragnehmer", "Unterverarbeiter",
    "Subprocessor", "Genehmigung Unterauftrag",
  ],
  betroffenenrechte: [
    "Betroffenenrechte", "Auskunft", "Berichtigung", "Löschung", "Einschränkung", "Datenübertragbarkeit",
    "Widerspruch", "Art. 15", "Art. 16", "Art. 17", "Art. 18", "Art. 20", "Art. 21",
  ],
  vorfallmeldung: [
    "Datenschutzverletzung", "Breach", "Meldung", "Meldepflicht", "72 Stunden", "Incident", "Sicherheitsvorfall",
  ],
  "löschung_rückgabe": [
    "Löschung", "Rückgabe", "nach Vertragsende", "Rückübertragung", "Vernichtung", "Deletion", "Return of Data",
  ],
  audit_nachweis: [
    "Audit", "Nachweis", "Kontrolle", "Inspektion", "Prüfung", "Auditrechte", "Nachweispflichten",
  ],
  // Zusatzklauseln
  internationale_übermittlungen: [
    "international", "Drittland", "Übermittlung", "Standardvertragsklauseln", "SCC", "SVK", "UK", "USA", "Transfer",
  ],
  haftungsbegrenzung: [
    "Haftung", "Haftungsbegrenzung", "Haftungsausschluss", "limitiert", "beschränkt", "Liability",
  ],
  gerichtsstand_recht: [
    "Gerichtsstand", "anwendbares Recht", "Rechtswahl", "Jurisdiction", "Governing Law",
  ],
};

/* ---- PDF-Text pro Seite: robust ohne Worker mit pdf-parse ---- */
async function extractPdfTextPerPage(file: ArrayBuffer): Promise<{ joined: string; pages: string[] }> {
  const pdfParseMod = await import("pdf-parse");
  const pdfParse = (pdfParseMod as any).default ?? (pdfParseMod as any);

  const pages: string[] = [];
  const res = await pdfParse(Buffer.from(file), {
    pagerender: async (pageData: any) => {
      const tc = await pageData.getTextContent();
      // KEIN aggressives Entfernen von Zeilenumbrüchen – Struktur behalten
      const text = (tc.items || [])
        .map((it: any) => (it.str ?? ""))
        .join("\n")
        .replace(/[ \t]+\n/g, "\n") // trailing spaces vor Zeilenumbruch weg
        .replace(/\n{3,}/g, "\n\n") // keine zu langen Lücken
        .trim();
      pages.push(text);
      return "";
    },
    max: 80,
  });

  // Fallback: res.text falls pagerender nichts brachte (z.B. gescannt)
  if (pages.length === 0) {
    const flat = String(res?.text || "").trim();
    if (!flat) return { joined: "", pages: [] };
    return { joined: `Seite 1:\n${flat.slice(0, 120000)}`, pages: [flat] };
  }

  const joined = pages
    .map((t, i) => `Seite ${i + 1}:\n${t}`)
    .join("\n\n---\n\n");

  return { joined: joined.length > 120000 ? joined.slice(0, 120000) : joined, pages };
}

/* ---------- baue kompakten Hinweis-Block aus KEYWORDS je Seite ---------- */
function buildKeywordHints(pages: string[]): string {
  if (!pages.length) return "";
  const lines: string[] = [];
  const lowerPages = pages.map((p) => p.toLowerCase());

  const groups: Array<{ canon: string; label: string }> = [
    { canon: "weisung", label: "weisung" },
    { canon: "vertraulichkeit", label: "vertraulichkeit" },
    { canon: "toms", label: "toms" },
    { canon: "unterauftragsverarbeiter", label: "unterauftragsverarbeiter" },
    { canon: "betroffenenrechte", label: "betroffenenrechte" },
    { canon: "vorfallmeldung", label: "vorfallmeldung" },
    { canon: "löschung_rückgabe", label: "löschung_rückgabe" },
    { canon: "audit_nachweis", label: "audit_nachweis" },
    { canon: "internationale_übermittlungen", label: "internationale_übermittlungen" },
    { canon: "haftungsbegrenzung", label: "haftungsbegrenzung" },
    { canon: "gerichtsstand_recht", label: "gerichtsstand_recht" },
  ];

  for (const g of groups) {
    const kws = KEYWORDS[g.canon] || [];
    if (!kws.length) continue;
    const hits: number[] = [];
    lowerPages.forEach((txt, idx) => {
      for (const kw of kws) {
        if (txt.includes(kw.toLowerCase())) { hits.push(idx + 1); break; }
      }
    });
    if (hits.length) {
      lines.push(`${g.label}: Seiten ${hits.join(", ")}`);
    }
  }

  if (!lines.length) return "";
  return `\n\nHinweise (Seiten mit passenden Schlüsselwörtern):\n${lines.map((l) => `- ${l}`).join("\n")}\n`;
}

/* ---------------- Normalisierung (EN/DE) ---------------- */
const STATUS_MAP: Record<string, "erfüllt" | "teilweise" | "fehlt" | "vorhanden" | "nicht gefunden"> = {
  met: "erfüllt",
  partial: "teilweise",
  missing: "fehlt",
  present: "vorhanden",
  not_found: "nicht gefunden",
  erfüllt: "erfüllt",
  teilweise: "teilweise",
  fehlt: "fehlt",
  vorhanden: "vorhanden",
  "nicht gefunden": "nicht gefunden",
};

const ART28_KEY_MAP: Record<string, string> = {
  instructions_only: "weisung",
  confidentiality: "vertraulichkeit",
  security_TOMs: "toms",
  subprocessors: "unterauftragsverarbeiter",
  data_subject_rights_support: "betroffenenrechte",
  breach_support: "vorfallmeldung",
  deletion_return: "löschung_rückgabe",
  audit_rights: "audit_nachweis",
  weisung: "weisung",
  vertraulichkeit: "vertraulichkeit",
  toms: "toms",
  unterauftragsverarbeiter: "unterauftragsverarbeiter",
  betroffenenrechte: "betroffenenrechte",
  vorfallmeldung: "vorfallmeldung",
  "löschung_rückgabe": "löschung_rückgabe",
  audit_nachweis: "audit_nachweis",
};

const EXTRAS_KEY_MAP: Record<string, string> = {
  international_transfers: "internationale_übermittlungen",
  liability_cap: "haftungsbegrenzung",
  jurisdiction: "gerichtsstand_recht",
  "internationale_übermittlungen": "internationale_übermittlungen",
  haftungsbegrenzung: "haftungsbegrenzung",
  gerichtsstand_recht: "gerichtsstand_recht",
};

function normalizeFromAgentLike(json: any) {
  const out: any = {
    vertrag_metadata: {},
    prüfung: { art_28: {}, zusatzklauseln: {} },
    risk_rationale: json?.risk_score?.rationale ?? null,
    actions: json?.actions ?? [],
  };

  if (json?.contract_metadata) {
    const m = json.contract_metadata;
    out.vertrag_metadata = {
      titel: m.title ?? "",
      datum: m.date ?? "",
      parteien: (m.parties ?? []).map((p: any) => ({
        rolle: p.role === "controller" ? "Verantwortlicher" : p.role === "processor" ? "Auftragsverarbeiter" : p.role ?? "",
        name: p.name ?? "",
        land: p.country ?? "",
      })),
    };
  }

  const a28 = json?.findings?.art_28 ?? {};
  for (const k of Object.keys(a28)) {
    const canon = ART28_KEY_MAP[k] ?? k;
    const st = STATUS_MAP[a28[k]?.status] ?? "fehlt";
    const belege = a28[k]?.evidence ?? a28[k]?.belege ?? [];
    out.prüfung.art_28[canon] = { status: st, belege };
  }

  const extras = json?.findings?.additional_clauses ?? {};
  for (const k of Object.keys(extras)) {
    const canon = EXTRAS_KEY_MAP[k] ?? k;
    const st = STATUS_MAP[extras[k]?.status] ?? "nicht gefunden";
    const belege = extras[k]?.evidence ?? extras[k]?.belege ?? [];
    out.prüfung.zusatzklauseln[canon] = { status: st, belege };
  }

  return out;
}

function normalizeFromModel(json: any) {
  const out: any = {
    vertrag_metadata: json?.vertrag_metadata ?? {},
    prüfung: { art_28: {}, zusatzklauseln: {} },
    risk_rationale: json?.risk_rationale ?? null,
    actions: json?.actions ?? [],
  };

  const a28 = json?.prüfung?.art_28 ?? {};
  for (const k of Object.keys(a28)) {
    const canon = ART28_KEY_MAP[k] ?? k;
    const st = STATUS_MAP[a28[k]?.status] ?? "fehlt";
    const belege = a28[k]?.belege ?? a28[k]?.evidence ?? [];
    out.prüfung.art_28[canon] = { status: st, belege };
  }

  const extras = json?.prüfung?.zusatzklauseln ?? {};
  for (const k of Object.keys(extras)) {
    const canon = EXTRAS_KEY_MAP[k] ?? k;
    const st = STATUS_MAP[extras[k]?.status] ?? "nicht gefunden";
    const belege = extras[k]?.belege ?? extras[k]?.evidence ?? [];
    out.prüfung.zusatzklauseln[canon] = { status: st, belege };
  }

  return out;
}

/* ---------------- Risiko (deterministisch, robust) ---------------- */
const WEIGHTS = { erfüllt: 0, teilweise: -10, fehlt: -25 };
function calcRisk(norm: any): number | null {
  const keys = [
    "weisung", "vertraulichkeit", "toms", "unterauftragsverarbeiter",
    "betroffenenrechte", "vorfallmeldung", "löschung_rückgabe", "audit_nachweis",
  ];
  let seen = 0;
  let s = 100;
  for (const k of keys) {
    const st = norm?.art_28?.[k]?.status;
    if (!st) continue;
    seen++;
    if (st === "teilweise") s += WEIGHTS.teilweise;
    else if (st === "fehlt") s += WEIGHTS.fehlt;
  }
  if (seen === 0) return null;
  return Math.max(0, Math.min(100, Math.round(s)));
}

/* ---------------- Handler ---------------- */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "Keine Datei übergeben" }, { status: 400 });

    const bytes = await file.arrayBuffer();

    // 1) Text extrahieren
    const { joined, pages } = await extractPdfTextPerPage(bytes);

    // 2) Keyword-Hinweise erzeugen (steigert Trefferquote für Belege)
    const hints = buildKeywordHints(pages);
    const userContent = `${joined}${hints}`;

    // 3) Modell aufrufen
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4.1",
        temperature: 0,
        top_p: 1,
        max_output_tokens: 4000,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [{ type: "input_text", text: userContent }] },
        ],
      }),
    });

    const api = await resp.json();
    if (!resp.ok) {
      return NextResponse.json({ error: "OpenAI error", details: api }, { status: 500 });
    }

    const rawText =
      api?.output_text ||
      api?.output?.[0]?.content?.[0]?.text ||
      api?.choices?.[0]?.message?.content ||
      "";

    const jsonStr = rawText.trim().replace(/^```json\s*|\s*```$/g, "");
    let modelJson: any;
    try {
      modelJson = JSON.parse(jsonStr);
    } catch {
      return NextResponse.json({ error: "Ungültiges JSON", preview: jsonStr.slice(0, 300) }, { status: 500 });
    }

    // 4) Normalisieren (Agent-Format vs. Model-Format)
    const looksLikeAgent = !!(modelJson?.contract_metadata && modelJson?.findings);
    const normBlock = looksLikeAgent ? normalizeFromAgentLike(modelJson) : normalizeFromModel(modelJson);

    // 5) Risiko (bevorzugt bereitgestellten Score, sonst deterministisch)
    const providedRisk =
      modelJson?.risk_score?.overall ?? modelJson?.risiko_score?.gesamt ?? null;
    const computedRisk = calcRisk(normBlock.prüfung);
    const riskFinal = (typeof providedRisk === "number") ? providedRisk : computedRisk;

    const result = {
      vertrag_metadata: normBlock.vertrag_metadata,
      prüfung: normBlock.prüfung,
      actions: normBlock.actions ?? [],
      risk_rationale:
        modelJson?.risk_rationale ??
        modelJson?.risk_score?.rationale ??
        (computedRisk == null ? "Keine zuverlässige Bewertung möglich (zu wenig Text erkannt)." : null),
      risiko_score: riskFinal == null ? null : {
        gesamt: riskFinal,
        typ: "risiko",
        erklärung: "Berechnung: erfüllt=0, teilweise=-10, fehlt=-25 (Startwert 100, 0–100).",
      },
      // Kompatibilität für die bestehende UI
      risk_score: riskFinal == null ? null : {
        overall: riskFinal,
        rationale: modelJson?.risk_rationale ?? modelJson?.risk_score?.rationale ?? null,
        type: "risk",
      },
    };

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: "Serverfehler", details: e?.message ?? String(e) }, { status: 500 });
  }
}