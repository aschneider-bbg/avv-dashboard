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

/* ---------------- Normalisierung (EN/DE) ---------------- */

const STATUS_MAP: Record<string, "erfüllt" | "teilweise" | "fehlt" | "vorhanden" | "nicht gefunden"> = {
  // EN
  met: "erfüllt",
  partial: "teilweise",
  missing: "fehlt",
  present: "vorhanden",
  not_found: "nicht gefunden",
  "not_found": "nicht gefunden",

  // DE
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
  // DE-Passthrough
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
  // DE-Passthrough
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

  // Metadata
  if (json?.contract_metadata) {
    const m = json.contract_metadata;
    out.vertrag_metadata = {
      titel: m.title ?? "",
      datum: m.date ?? "",
      parteien: (m.parties ?? []).map((p: any) => ({
        rolle: p.role === "controller" ? "Verantwortlicher" : p.role === "processor" ? "Auftragsverarbeiter" : (p.role ?? ""),
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

/* ---------------- PDF-Extraktion (robust) ---------------- */

async function extractPdfTextPerPage(file: ArrayBuffer): Promise<string> {
  // Minimaler DOMMatrix-Stub für pdfjs unter Node
  if (typeof (globalThis as any).DOMMatrix === "undefined") {
    (globalThis as any).DOMMatrix = class {
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      rotate() { return this; }
    };
  }

  const MAX_CHARS = 60000;
  const MIN_USEFUL = 10;

  // Helper: Seiten joinen & cappen
  const joinPages = (pages: string[]) => {
    const joined = pages.join("\n\n---\n\n");
    return joined.length > MAX_CHARS ? joined.slice(0, MAX_CHARS) : joined;
  };

  // 1) Primär: pdfjs-dist – zuerst mit disableCombineTextItems=false, dann true
  try {
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (pdfjs?.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc = undefined;
    }

    const tryPdfJs = async (disableCombineTextItems: boolean) => {
      const uint8 = new Uint8Array(file);
      const doc = await pdfjs.getDocument({
        data: uint8,
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: true,
      }).promise;

      const pages: string[] = [];
      const maxPages = Math.min(doc.numPages, 120);
      let total = 0;

      for (let p = 1; p <= maxPages; p++) {
        const page = await doc.getPage(p);
        const content: any = await page.getTextContent({
          includeMarkedContent: true,
          disableCombineTextItems,
        }).catch(() => ({ items: [] }));

        const text: string = (content.items || [])
          .map((it: any) => (typeof it?.str === "string" ? it.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        pages.push(`Seite ${p}:\n${text}`);
        total += text.length;
        if (total > MAX_CHARS) break;
      }
      const joined = joinPages(pages);
      return joined && joined.replace(/\s/g, "").length >= MIN_USEFUL ? joined : "";
    };

    let out = await tryPdfJs(false);
    if (!out) out = await tryPdfJs(true);
    if (out) return out;
  } catch (e) {
    // pdfjs kann bei defektem XRef scheitern → weiter zum Fallback
    // console.warn("pdfjs failed:", e);
  }

  // 2) Fallback: pdf-parse – tolerant splitten
  try {
    const pdfParse: any = (await import("pdf-parse")).default;
    const buffer = Buffer.from(file);
    const parsed: { text?: string } = await pdfParse(buffer);
    const raw = (parsed?.text || "").replace(/\r/g, "");
    if (raw && raw.replace(/\s/g, "").length >= MIN_USEFUL) {
      const parts: string[] = raw.includes("\f")
        ? raw.split("\f")
        : raw.split(/\n{2,}/g);
      const pages: string[] = parts
        .map((t: string, i: number) => `Seite ${i + 1}:\n${t.replace(/\s+/g, " ").trim()}`)
        .filter((s) => s.replace(/\s/g, "").length > 0);
      const joined = joinPages(pages);
      if (joined && joined.replace(/\s/g, "").length >= MIN_USEFUL) return joined;
    }
  } catch (e) {
    // console.warn("pdf-parse failed:", e);
  }

  // 3) Letzter Ausweg: Wir geben wenigstens 1 "Seite" mit rohem Byte-Hinweis zurück,
  // damit das Modell nicht komplett im Leeren steht (besser als harter Abbruch).
  // Das triggert eine schwache, aber nicht leere Analyse und verhindert 500er.
  return `Seite 1:
(Keine extrahierbaren Textinhalte gefunden. PDF könnte nur aus gescannten Bildern bestehen oder beschädigt sein.)`;
}

/* ---------------- Risiko/Compliance ---------------- */

// Compliance (aus Labels): erfüllt=1, teilweise=0.5, fehlt=0 (+ Extras-Bonus)
function complianceFromFindings(normPruefung: any): number | null {
  if (!normPruefung?.art_28) return null;
  const keys = [
    "weisung","vertraulichkeit","toms","unterauftragsverarbeiter",
    "betroffenenrechte","vorfallmeldung","löschung_rückgabe","audit_nachweis",
  ];
  let achieved = 0;
  let total = keys.length;
  for (const k of keys) {
    const st: string | undefined = normPruefung.art_28?.[k]?.status;
    if (st === "erfüllt") achieved += 1;
    else if (st === "teilweise") achieved += 0.5;
  }
  let score = (achieved / total) * 100;

  const extras = normPruefung?.zusatzklauseln || {};
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

    // Normalisieren
    const looksLikeAgent = !!(modelJson?.contract_metadata && modelJson?.findings);
    const normBlock = looksLikeAgent ? normalizeFromAgentLike(modelJson) : normalizeFromModel(modelJson);

    // Compliance bevorzugen, Risiko ableiten (100 - Compliance), wenn nichts vom Modell kommt
    const complianceProvided: number | null =
      typeof modelJson?.compliance_score?.overall === "number" ? modelJson.compliance_score.overall : null;

    const complianceCalc = complianceFromFindings(normBlock.prüfung);
    const complianceFinal = complianceProvided ?? complianceCalc ?? null;

    const providedRisk =
      modelJson?.risk_score?.overall ?? modelJson?.risiko_score?.gesamt ?? null;
    const riskFinal = (typeof providedRisk === "number")
      ? providedRisk
      : (typeof complianceFinal === "number" ? Math.max(0, 100 - complianceFinal) : null);

    const result = {
      vertrag_metadata: normBlock.vertrag_metadata,
      prüfung: normBlock.prüfung,
      actions: normBlock.actions ?? [],
      risk_rationale:
        modelJson?.risk_rationale ??
        modelJson?.risk_score?.rationale ??
        (complianceFinal == null ? "Keine zuverlässige Bewertung möglich (zu wenig Text erkannt)." : null),
      // Neue Compliance-Form
      compliance_score: complianceFinal == null ? null : {
        overall: complianceFinal,
        type: "compliance",
      },
      // Risiko (kompatibel)
      risiko_score: riskFinal == null ? null : {
        gesamt: riskFinal,
        typ: "risiko",
        erklärung: "Ableitung: Risiko = 100 - Compliance. Hoher Compliance-Score bedeutet geringes Risiko.",
      },
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