import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------------- Prompt (Deutsch) ---------------- */
const SYSTEM_PROMPT = `
Du bist ein AVV-Analyst. Lies den Vertragstext (pro Seite markiert) und gib AUSSCHLIESSLICH valides JSON zurück:

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
- Status genau im genannten Vokabular.
- Belege immer mit "page" (Seite aus dem bereitgestellten Text; Seiten sind als "Seite N:" markiert) und kurzem "quote".
- Nur das JSON, keine Markdown-Fences.
`;

/* ---- PDF-Text pro Seite (pdfjs-dist v5, Node/Vercel-kompatibel, ohne Worker) ---- */
async function extractPdfTextPerPage(file: ArrayBuffer): Promise<string> {
  // Minimaler DOMMatrix-Stub – nur falls pdfjs danach fragt (Node hat das nicht)
  if (typeof (globalThis as any).DOMMatrix === "undefined") {
    (globalThis as any).DOMMatrix = class {
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      rotate() { return this; }
    };
  }

  try {
    // WICHTIG: v5 → legacy/build/pdf.mjs
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");

    const uint8 = new Uint8Array(file);
    const doc = await pdfjs.getDocument({ data: uint8, isEvalSupported: false }).promise;

    const pages: string[] = [];
    const maxPages = Math.min(doc.numPages, 80);
    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = content.items.map((it: any) => it.str).join(" ").replace(/\s+/g, " ").trim();
      pages.push(`Seite ${p}:\n${text}`);
    }
    const joined = pages.join("\n\n---\n\n");
    return joined.length > 60000 ? joined.slice(0, 60000) : joined;
  } catch {
    // Optionaler Fallback: pdf-parse (falls du das installiert hast)
    try {
      const pdfParse = (await import("pdf-parse")).default as any;
      const buf = Buffer.from(file);
      const r = await pdfParse(buf);
      const text = (r.text || "").replace(/\s+\n/g, "\n").trim();
      return `Seite 1:\n${text}`;
    } catch {
      return "Seite 1:\n[PDF konnte serverseitig nicht extrahiert werden]";
    }
  }
}


/* ---------------- Normalisierung (EN/DE) ---------------- */
const STATUS_MAP: Record<string, "erfüllt" | "teilweise" | "fehlt" | "vorhanden" | "nicht gefunden"> = {
  met: "erfüllt",
  partial: "teilweise",
  missing: "fehlt",
  present: "vorhanden",
  "not_found": "nicht gefunden",
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
  // deutsche Varianten direkt durchreichen
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
  // deutsche Varianten
  "internationale_übermittlungen": "internationale_übermittlungen",
  haftungsbegrenzung: "haftungsbegrenzung",
  gerichtsstand_recht: "gerichtsstand_recht",
};

function normalizeFromAgentLike(json: any) {
  // akzeptiert: { contract_metadata, findings{art_28, additional_clauses}, risk_score?, actions? }
  const out: any = {
    vertrag_metadata: {},
    prüfung: { art_28: {}, zusatzklauseln: {} },
    risk_rationale: json?.risk_score?.rationale ?? null,
    actions: json?.actions ?? [],
  };

  // Metadata
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

  // Art.28
  const a28 = json?.findings?.art_28 ?? {};
  for (const k of Object.keys(a28)) {
    const canon = ART28_KEY_MAP[k] ?? k;
    const st = STATUS_MAP[a28[k]?.status] ?? "fehlt";
    const belege = a28[k]?.evidence ?? a28[k]?.belege ?? [];
    out.prüfung.art_28[canon] = { status: st, belege };
  }

  // Zusatzklauseln
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
  // akzeptiert unser Ziel-Schema { vertrag_metadata, prüfung{...}, risk_rationale? }
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
  if (seen === 0) return null; // keine Daten → Risiko nicht anzeigen
  return Math.max(0, Math.min(100, Math.round(s)));
}

/* ---------------- Handler ---------------- */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "Keine Datei übergeben" }, { status: 400 });

    const bytes = await file.arrayBuffer();
    const textByPage = await extractPdfTextPerPage(bytes);

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
        max_output_tokens: 2500,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [{ type: "input_text", text: textByPage }] },
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

    // Erkennen & normalisieren (Agent-Format vs. Model-Format)
    const looksLikeAgent = !!(modelJson?.contract_metadata && modelJson?.findings);
    const normBlock = looksLikeAgent ? normalizeFromAgentLike(modelJson) : normalizeFromModel(modelJson);

    // Risiko: bevorzugt vorhandenes risk_score.overall, sonst deterministisch
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
      // Kompatibilität
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
