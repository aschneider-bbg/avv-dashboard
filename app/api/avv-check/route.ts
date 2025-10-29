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

/* ----------------------------------------------------------------
 * ROBUSTE PDF-EXTRAKTION
 *  - pdfjs-dist tolerant gegen defekte XRef ("bad XRef entry")
 *  - zweiter Versuch mit geänderten Flags
 *  - Fallback auf pdf-parse (falls installiert)
 * ---------------------------------------------------------------- */
async function extractPdfTextPerPage(file: ArrayBuffer): Promise<string> {
  // DOMMatrix-Stub für Node (pdfjs erwartet es in einigen Pfaden)
  if (typeof (globalThis as any).DOMMatrix === "undefined") {
    (globalThis as any).DOMMatrix = class {
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      rotate() { return this; }
    };
  }

  const uint8 = new Uint8Array(file);

  // 1) Versuch: pdfjs-dist (tolerant)
  try {
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");

    const tryOnce = async (opts: any) => {
      const task = pdfjs.getDocument({
        data: uint8,
        isEvalSupported: false,
        stopAtErrors: false,    // <— wichtig gegen „bad XRef entry“
        disableAutoFetch: true, // weniger Range-Fetch, robuster
        ...opts,
      });
      const doc = await task.promise;

      const maxPages = Math.min(doc.numPages, 80);
      const pages: string[] = [];
      let chars = 0;

      for (let p = 1; p <= maxPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent().catch(() => ({ items: [] }));
        const text = (content.items || [])
          .map((it: any) => (typeof it.str === "string" ? it.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        chars += text.length;
        pages.push(`Seite ${p}:\n${text}`);

        if (chars > 60000) break; // harte Kappung
      }

      const joined = pages.join("\n\n---\n\n");
      return joined.length > 60000 ? joined.slice(0, 60000) : joined;
    };

    try {
      return await tryOnce({});
    } catch {
      // zweiter Versuch mit alternativen Optionen
      return await tryOnce({ rangeChunkSize: 1 << 16, useSystemFonts: true });
    }
  } catch {
    // falle zum Fallback durch
  }

  // 2) Fallback: pdf-parse (wenn installiert)
  try {
    const mod: any = await import("pdf-parse").catch(() => null);
    const pdfParse = mod?.default || mod;
    if (pdfParse) {
      const res = await pdfParse(Buffer.from(uint8));
      const text = String(res?.text || "").replace(/\s+\n/g, "\n").trim();
      if (text) {
        const chunks = text.split(/\n{2,}/g).filter(Boolean).slice(0, 40);
        const joined = chunks.map((t, i) => `Seite ${i + 1}:\n${t}`).join("\n\n---\n\n");
        return joined.length > 60000 ? joined.slice(0, 60000) : joined;
      }
    }
  } catch {
    // Ignorieren, finaler Fallback unten
  }

  // 3) Letzter Fallback: leer
  return "";
}

/* ---------------- Normalisierung (EN/DE) ---------------- */
const STATUS_MAP: Record<string, "erfüllt" | "teilweise" | "fehlt" | "vorhanden" | "nicht gefunden"> = {
  // englische Varianten
  met: "erfüllt",
  partial: "teilweise",
  missing: "fehlt",
  present: "vorhanden",
  not_found: "nicht gefunden",
  "not_found": "nicht gefunden",
  // deutsche Varianten
  erfüllt: "erfüllt",
  teilweise: "teilweise",
  fehlt: "fehlt",
  vorhanden: "vorhanden",
  "nicht gefunden": "nicht gefunden",
};

const ART28_KEY_MAP: Record<string, string> = {
  // EN → DE
  instructions_only: "weisung",
  confidentiality: "vertraulichkeit",
  security_TOMs: "toms",
  subprocessors: "unterauftragsverarbeiter",
  data_subject_rights_support: "betroffenenrechte",
  breach_support: "vorfallmeldung",
  deletion_return: "löschung_rückgabe",
  audit_rights: "audit_nachweis",
  // DE passthrough
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

  // Art. 28
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

/* ---------------- Scoring: Compliance & Risiko ---------------- */
const A28_KEYS_ORDER = [
  "weisung",
  "vertraulichkeit",
  "toms",
  "unterauftragsverarbeiter",
  "betroffenenrechte",
  "vorfallmeldung",
  "löschung_rückgabe",
  "audit_nachweis",
];

function calcCompliance(norm: any): number | null {
  const a28 = norm?.art_28 ?? {};
  let seen = 0;
  let achieved = 0;

  for (const k of A28_KEYS_ORDER) {
    const st = a28?.[k]?.status;
    if (!st) continue;
    seen++;
    if (st === "erfüllt") achieved += 1;
    else if (st === "teilweise") achieved += 0.5;
  }
  if (seen === 0) return null;

  // Grundscore aus Art.28
  let score = (achieved / A28_KEYS_ORDER.length) * 100;

  // Extras leicht positiv werten (optional)
  const extras = norm?.zusatzklauseln ?? {};
  const intl = extras?.["internationale_übermittlungen"]?.status;
  if (intl === "erfüllt") score += 10;
  else if (intl === "teilweise") score += 5;
  else if (intl === "vorhanden") score += 3;

  const liab = extras?.["haftungsbegrenzung"]?.status;
  if (liab === "erfüllt" || liab === "vorhanden") score += 3;

  const juris = extras?.["gerichtsstand_recht"]?.status;
  if (juris === "erfüllt" || juris === "vorhanden") score += 2;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function calcRiskFromCompliance(comp: number | null): number | null {
  if (comp == null) return null;
  return Math.max(0, Math.min(100, 100 - comp));
}

/* ---------------- Handler ---------------- */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "Keine Datei übergeben" }, { status: 400 });

    const bytes = await file.arrayBuffer();
    const textByPage = await extractPdfTextPerPage(bytes);

    // Früh abbrechen, wenn wirklich nichts extrahiert wurde
    if (!textByPage || textByPage.trim().length < 40) {
      return NextResponse.json(
        {
          error: "PDF konnte nicht robust extrahiert werden",
          details:
            "Der PDF-Text ist leer oder beschädigt (z.B. defekte XRef-Tabelle). Bitte eine unveränderte/„nicht linearisierte“ PDF-Version verwenden oder das Original neu exportieren.",
        },
        { status: 400 }
      );
    }

    // OpenAI Responses API – ohne JSON-Schema-Zwang (robuster), strikt durch Prompt
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

    const jsonStr = String(rawText).trim().replace(/^```json\s*|\s*```$/g, "");
    let modelJson: any;
    try {
      modelJson = JSON.parse(jsonStr);
    } catch {
      return NextResponse.json(
        { error: "Ungültiges JSON", preview: jsonStr.slice(0, 300) },
        { status: 500 }
      );
    }

    // Normalisieren (Agent-Format vs. Model-Format)
    const looksLikeAgent = !!(modelJson?.contract_metadata && modelJson?.findings);
    const normBlock = looksLikeAgent ? normalizeFromAgentLike(modelJson) : normalizeFromModel(modelJson);

    // Compliance & Risiko bestimmen
    const providedCompliance =
      typeof modelJson?.compliance_score?.overall === "number" ? modelJson.compliance_score.overall : null;
    const computedCompliance = calcCompliance(normBlock.prüfung);
    const finalCompliance = providedCompliance ?? computedCompliance;

    const providedRisk =
      typeof modelJson?.risk_score?.overall === "number" ? modelJson.risk_score.overall :
      typeof modelJson?.risiko_score?.gesamt === "number" ? modelJson.risiko_score.gesamt :
      null;

    const finalRisk = providedRisk ?? calcRiskFromCompliance(finalCompliance);

    const result = {
      vertrag_metadata: normBlock.vertrag_metadata,
      prüfung: normBlock.prüfung,
      actions: normBlock.actions ?? [],
      risk_rationale:
        modelJson?.risk_rationale ??
        modelJson?.risk_score?.rationale ??
        (finalCompliance == null ? "Keine zuverlässige Bewertung möglich (zu wenig Text erkannt)." : null),
      // neue, explizite Compliance-Ausgabe (0–100, höher = besser)
      compliance_score: finalCompliance == null ? null : {
        overall: finalCompliance,
        type: "compliance",
      },
      // Risiko (0–100, höher = schlechter)
      risiko_score: finalRisk == null ? null : {
        gesamt: finalRisk,
        typ: "risiko",
        erklärung:
          providedRisk != null
            ? "Vom Modell/Agenten geliefert."
            : "Ableitung: Risiko = 100 - Compliance. Hoher Compliance-Score bedeutet geringes Risiko.",
      },
      // Kompatibilität
      risk_score: finalRisk == null ? null : {
        overall: finalRisk,
        rationale: modelJson?.risk_rationale ?? modelJson?.risk_score?.rationale ?? null,
        type: "risk",
      },
    };

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { error: "Serverfehler", details: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}