import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------- System Prompt ------------------- */
const SYSTEM_PROMPT = `
Du bist ein AVV-Analyst. Lies den Vertragstext (Seiten sind mit "Seite N:" markiert) und liefere AUSSCHLIESSLICH valides JSON gemäß vorgegebenem Schema.
Wichtig:
- Nutze die bereitgestellten "Hinweise" (Snippets je Kategorie) aktiv, um Belege zu finden.
- Belege IMMER mit "page" (Seitenzahl, wie "Seite N") und kurzem "quote".
- Wenn eindeutige Regelung vorhanden: status="met".
- Wenn nur teilweise/unscharf geregelt (z.B. "angemessene Frist", unvollständig): status="partial".
- Wenn nichts erkennbar: status="missing".
- Keine Markdown-Fences, nur JSON.
`;

/* ---------- Keyword-Lexikon (für Snippets) ---------- */
const KEYWORDS: Record<string, string[]> = {
  instructions_only: ["Weisung", "Weisungen", "Instruktion", "Instruction"],
  confidentiality: ["Vertraulichkeit", "Verschwiegenheit", "Geheimhaltung", "Confidentiality", "Datengeheimnis"],
  security_TOMs: ["Technisch-organisatorisch", "TOM", "TOMs", "Stand der Technik", "Sicherheitsmaßnahme", "Privacy by Design", "Privacy by Default", "ISO 27001"],
  subprocessors: ["Unterauftragsverarbeiter", "Subunternehmer", "Subprozessor", "Unterauftragnehmer", "Subprocessor", "Genehmigung Unterauftrag"],
  data_subject_rights_support: ["Betroffenenrechte", "Auskunft", "Berichtigung", "Löschung", "Einschränkung", "Übertragbarkeit", "Widerspruch", "Art. 15", "Art. 16", "Art. 17", "Art. 18", "Art. 20", "Art. 21"],
  breach_support: ["Datenschutzverletzung", "Breach", "Meldung", "Meldepflicht", "72 Stunden", "Incident", "Sicherheitsvorfall"],
  deletion_return: ["Löschung", "Rückgabe", "nach Vertragsende", "Rückübertragung", "Vernichtung", "Deletion", "Return of Data"],
  audit_rights: ["Audit", "Nachweis", "Kontrolle", "Inspektion", "Prüfung", "Auditrechte", "Nachweispflichten"],
  international_transfers: ["international", "Drittland", "Übermittlung", "Transfer", "Standardvertragsklauseln", "SCC", "SVK", "UK", "USA", "EU 2021/914", "2021/915"],
  liability_cap: ["Haftung", "Haftungsbegrenzung", "Haftungsausschluss", "limitiert", "beschränkt", "Liability"],
  jurisdiction: ["Gerichtsstand", "anwendbares Recht", "Rechtswahl", "Jurisdiction", "Governing Law"],
};

/* ---------- Responses API: JSON Schema (Agent-Builder-Format) ---------- */
const RESPONSE_JSON_SCHEMA = {
  name: "AVVSchema",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      contract_metadata: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          date: { type: "string" },
          parties: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                role: { type: "string", enum: ["controller", "processor", "other"] },
                name: { type: "string" },
                country: { type: "string" },
              },
              required: ["role", "name"],
            },
          },
        },
        required: ["title", "date", "parties"],
      },
      findings: {
        type: "object",
        additionalProperties: false,
        properties: {
          art_28: {
            type: "object",
            additionalProperties: false,
            properties: {
              instructions_only: statusBlock(),
              confidentiality: statusBlock(),
              security_TOMs: statusBlock(),
              subprocessors: statusBlock(),
              data_subject_rights_support: statusBlock(),
              breach_support: statusBlock(),
              deletion_return: statusBlock(),
              audit_rights: statusBlock(),
            },
            required: [
              "instructions_only",
              "confidentiality",
              "security_TOMs",
              "subprocessors",
              "data_subject_rights_support",
              "breach_support",
              "deletion_return",
              "audit_rights",
            ],
          },
          additional_clauses: {
            type: "object",
            additionalProperties: false,
            properties: {
              international_transfers: statusBlock(["met", "partial", "missing", "present", "not_found"]),
              liability_cap: statusBlock(["met", "partial", "missing", "present", "not_found"]),
              jurisdiction: statusBlock(["met", "partial", "missing", "present", "not_found"]),
            },
            required: ["international_transfers", "liability_cap", "jurisdiction"],
          },
        },
        required: ["art_28", "additional_clauses"],
      },
      risk_score: {
        type: "object",
        additionalProperties: false,
        properties: {
          overall: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["overall", "rationale"],
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            severity: { type: "string", enum: ["high", "medium", "low"] },
            issue: { type: "string" },
            suggested_clause: { type: "string" },
          },
          required: ["severity", "issue", "suggested_clause"],
        },
      },
    },
    required: ["contract_metadata", "findings", "risk_score", "actions"],
  },
  strict: true,
} as const;

function statusBlock(statuses: string[] = ["met", "partial", "missing"]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: statuses },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            quote: { type: "string" },
            page: { type: "number" },
          },
          required: ["quote", "page"],
        },
      },
    },
    required: ["status", "evidence"],
  };
}

/* ---------- PDF-Extraktion (ohne Worker) ---------- */
async function extractPdf(file: ArrayBuffer): Promise<{ joined: string; pages: string[] }> {
  const pdfParseMod = await import("pdf-parse");
  const pdfParse = (pdfParseMod as any).default ?? (pdfParseMod as any);

  const pages: string[] = [];
  const res = await pdfParse(Buffer.from(file), {
    pagerender: async (pageData: any) => {
      const tc = await pageData.getTextContent();
      const text = (tc.items || [])
        .map((it: any) => (it.str ?? ""))
        .join("\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      pages.push(text);
      return "";
    },
    max: 80,
  });

  if (pages.length === 0) {
    const flat = String(res?.text || "").trim();
    if (!flat) return { joined: "", pages: [] };
    return { joined: `Seite 1:\n${flat.slice(0, 120000)}`, pages: [flat] };
  }

  const joined = pages.map((t, i) => `Seite ${i + 1}:\n${t}`).join("\n\n---\n\n");
  return { joined: joined.length > 120000 ? joined.slice(0, 120000) : joined, pages };
}

/* ---------- Snippets um Treffer (bessere Evidenzfindung) ---------- */
function buildSnippets(pages: string[], window = 260, maxSnipsPerCat = 6) {
  const lowerPages = pages.map((p) => p.toLowerCase());
  const out: Record<string, Array<{ page: number; snippet: string }>> = {};

  const cats = Object.keys(KEYWORDS) as Array<keyof typeof KEYWORDS>;
  for (const cat of cats) {
    out[cat] = [];
    const kws = KEYWORDS[cat];
    lowerPages.forEach((txt, idx) => {
      for (const kw of kws) {
        const pos = txt.indexOf(kw.toLowerCase());
        if (pos >= 0) {
          const raw = pages[idx];
          const start = Math.max(0, pos - window);
          const end = Math.min(raw.length, pos + kw.length + window);
          out[cat].push({ page: idx + 1, snippet: raw.slice(start, end).replace(/\s+/g, " ").trim() });
          break; // pro Seite nur ein Treffer pro Kategorie
        }
      }
    });
    // Deckeln
    if (out[cat].length > maxSnipsPerCat) out[cat] = out[cat].slice(0, maxSnipsPerCat);
  }
  return out;
}

/* ---------- Hints-Block für den Prompt ---------- */
function renderHints(snips: Record<string, Array<{ page: number; snippet: string }>>) {
  const order = [
    "instructions_only",
    "confidentiality",
    "security_TOMs",
    "subprocessors",
    "data_subject_rights_support",
    "breach_support",
    "deletion_return",
    "audit_rights",
    "international_transfers",
    "liability_cap",
    "jurisdiction",
  ] as const;

  const parts: string[] = [];
  parts.push("Hinweise (Snippets je Kategorie; bitte vorrangig durchsuchen):");
  for (const key of order) {
    const arr = snips[key] || [];
    if (!arr.length) continue;
    parts.push(`- ${key}:`);
    for (const s of arr) {
      parts.push(`  • Seite ${s.page}: ${s.snippet}`);
    }
  }
  return parts.join("\n");
}

/* ---------- Normalisierung (EN→DE & Keys) ---------- */
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
};
const EXTRAS_KEY_MAP: Record<string, string> = {
  international_transfers: "internationale_übermittlungen",
  liability_cap: "haftungsbegrenzung",
  jurisdiction: "gerichtsstand_recht",
};

function normalizeAgentLike(json: any) {
  const out: any = { vertrag_metadata: {}, prüfung: { art_28: {}, zusatzklauseln: {} }, actions: json?.actions ?? [] };

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
    const belege = a28[k]?.evidence ?? [];
    out.prüfung.art_28[canon] = { status: st, belege };
  }
  const extras = json?.findings?.additional_clauses ?? {};
  for (const k of Object.keys(extras)) {
    const canon = EXTRAS_KEY_MAP[k] ?? k;
    const st = STATUS_MAP[extras[k]?.status] ?? "nicht gefunden";
    const belege = extras[k]?.evidence ?? [];
    out.prüfung.zusatzklauseln[canon] = { status: st, belege };
  }

  return out;
}

/* ---------- Risiko (deterministisch, falls Modell nichts liefert) ---------- */
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

    // (1) PDF extrahieren
    const { joined, pages } = await extractPdf(bytes);
    if (!joined) {
      return NextResponse.json({ error: "Kein extrahierbarer Text (evtl. gescanntes PDF ohne OCR)." }, { status: 400 });
    }

    // (2) Snippets bauen & Hints erzeugen
    const snips = buildSnippets(pages);
    const hintsBlock = renderHints(snips);
    const userText = `${joined}\n\n${hintsBlock}`;

    // (3) Responses API mit JSON-Schema (Agent-Format)
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
        max_output_tokens: 5000,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [{ type: "input_text", text: userText }] },
        ],
        text: {
          format: {
            type: "json_schema",
            json_schema: RESPONSE_JSON_SCHEMA,
          },
        },
      }),
    });

    const api = await resp.json();
    if (!resp.ok) {
      return NextResponse.json({ error: "OpenAI error", details: api }, { status: 500 });
    }

    const raw =
      api?.output_text ||
      api?.output?.[0]?.content?.[0]?.text ||
      api?.choices?.[0]?.message?.content ||
      "";

    let modelJson: any;
    try {
      modelJson = JSON.parse(String(raw).trim());
    } catch {
      return NextResponse.json({ error: "Ungültiges JSON", preview: String(raw).slice(0, 300) }, { status: 500 });
    }

    // (4) In DE-UI-Format normalisieren (Agent-ähnlich → DE)
    const norm = normalizeAgentLike(modelJson);

    // (5) Risiko: bevorzugt vom Modell, sonst deterministisch
    const providedRisk = modelJson?.risk_score?.overall;
    const computedRisk = calcRisk(norm.prüfung);
    const riskFinal = (typeof providedRisk === "number") ? providedRisk : computedRisk;

    const result = {
      vertrag_metadata: norm.vertrag_metadata,
      prüfung: norm.prüfung,
      actions: norm.actions ?? [],
      risk_rationale: modelJson?.risk_score?.rationale ?? (computedRisk == null ? "Keine zuverlässige Bewertung möglich (zu wenig Text erkannt)." : null),
      risiko_score: riskFinal == null ? null : {
        gesamt: riskFinal,
        typ: "risiko",
        erklärung: "Berechnung: erfüllt=0, teilweise=-10, fehlt=-25 (Startwert 100, 0–100).",
      },
      // Kompatibilität
      risk_score: riskFinal == null ? null : {
        overall: riskFinal,
        rationale: modelJson?.risk_score?.rationale ?? null,
        type: "risk",
      },
    };

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: "Serverfehler", details: e?.message ?? String(e) }, { status: 500 });
  }
}