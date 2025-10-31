import { NextRequest, NextResponse } from "next/server";
import { Agent, Runner, withTrace } from "@openai/agents";
import pdf from "pdf-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ========================= PDF → Text ========================= */
async function pdfToText(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  const data = await pdf(buf).catch(() => null);
  if (!data || !data.text?.trim()) throw new Error("PDF-Text leer oder nicht lesbar.");
  let text = data.text
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

/* ========================= Token-Schätzung ========================= */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/* ========================= Chunker ========================= */
function semanticChunkText(
  text: string,
  targetTokens = 8_000,
  hardMaxTokens = 9_500
): string[] {
  const strongDelim = new RegExp(
    [
      String.raw`(?=^.{0,6}(?:Kapitel|Abschnitt|Artikel|Art\.|§|Ziffer|Anhang)\b)`,
      String.raw`(?=^\s*(?:[IVXLC]+\.)\s)`,
      String.raw`(?=^\s*(?:\d{1,2}\.)\s)`,
      String.raw`(?=^\s*[A-ZÄÖÜ][A-ZÄÖÜ \-/]{5,}\s*$)`,
    ].join("|"),
    "m"
  );

  let blocks = text.split(strongDelim).map(s => s.trim()).filter(Boolean);
  if (blocks.length <= 1) {
    blocks = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  }

  const refined: string[] = [];
  for (const b of blocks) {
    if (estimateTokens(b) <= hardMaxTokens) {
      refined.push(b);
    } else {
      const paras = b.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
      let buf: string[] = [];
      let bufTokens = 0;
      for (const p of paras) {
        const t = estimateTokens(p) + 2;
        if (bufTokens + t > targetTokens && buf.length) {
          refined.push(buf.join("\n\n"));
          buf = [p];
          bufTokens = estimateTokens(p);
        } else if (t > hardMaxTokens) {
          const chunks = hardSplitByChars(p, hardMaxTokens * 4);
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

  const MIN_TOK = 1_000;
  const merged: string[] = [];
  let cursor = "";
  let curTok = 0;
  for (const seg of refined) {
    const t = estimateTokens(seg);
    if (!cursor) {
      cursor = seg; curTok = t; continue;
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

function hardSplitByChars(s: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += maxChars) {
    out.push(s.slice(i, i + maxChars));
  }
  return out;
}

/* ========================= JSON-Extraction ========================= */
function extractJson(output: string): any {
  if (!output) throw new Error("Leere Antwort vom Agent.");
  const cleaned = output.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const matches = cleaned.match(/\{[\s\S]*\}/g);
  if (!matches || matches.length === 0) throw new Error("Kein JSON-Block gefunden.");
  // nimm den größten Block – meist der finale
  const biggest = matches.sort((a, b) => b.length - a.length)[0];
  return JSON.parse(biggest);
}

/* === Scoring-Konstanten === */
const WEIGHTS: Record<string, number> = {
  instructions_only: 15,
  confidentiality: 10,
  security_TOMs: 20,
  subprocessors: 15,
  data_subject_rights_support: 10,
  breach_support: 10,
  deletion_return: 10,
  audit_rights: 10,
};

const STATUS_TO_FACTOR = (s?: string) => {
  const v = (s || "").toLowerCase();
  if (v === "met" || v === "erfüllt") return 1;
  if (v === "partial" || v === "teilweise") return 0.5;
  return 0;
};

const isArray = (v: any): v is any[] => Array.isArray(v);
const toArray = <T,>(v: any): T[] => (Array.isArray(v) ? v : []);
const trimQuote = (s: string) => s.replace(/\s+/g, " ").slice(0, 240);

/* === Mapping für Findings → gewünschtes Schema === */
const A28_KEYS = new Set([
  "instructions_only","confidentiality","security_TOMs","subprocessors",
  "data_subject_rights_support","breach_support","deletion_return","audit_rights",
]);

const EXTRA_KEYS = new Set([
  "international_transfers","liability_cap","jurisdiction",
]);

/* === Reconciliation & Re-Score === */
function reconcileAndScore(raw: any) {
  const out: any = {
    executive_summary: raw?.executive_summary ?? "",
    contract_metadata: {
      title: raw?.contract_metadata?.title ?? "",
      date: raw?.contract_metadata?.date ?? "",
      parties: raw?.contract_metadata?.parties ?? raw?.parties ?? null,
    },
    article_28_analysis: {},
    additional_clauses: {},
    recommended_actions: [],
    compliance_score: { overall: 0, details: {} as Record<string, number> },
    risk_score: { overall: 0, rationale: raw?.risk_score?.rationale ?? "" },
    version: "2025-10-31-stable2",
  };

  /* ---- Parteien normalisieren (Array ODER Objekt) ---- */
  const p = out.contract_metadata.parties;
  if (p && !isArray(p) && typeof p === "object") {
    // Objektform → in schönes Array für Frontend
    const arr: any[] = [];
    if (p.controller) arr.push({ rolle: "Verantwortlicher", name: String(p.controller), land: p.country || "DE" });
    if (p.processor)  arr.push({ rolle: "Auftragsverarbeiter", name: String(p.processor),  land: p.country || "DE" });
    if (p.processor_dpo) {
      // DSB nicht als Partei zurückgeben – nur Meta
      out.contract_metadata.processor_dpo = String(p.processor_dpo);
    }
    out.contract_metadata.parties = arr;
  } else if (!isArray(p)) {
    out.contract_metadata.parties = [];
  }

  /* ---- Findings aus beliebigen Feldern einsammeln ---- */
  const buckets: Record<string, any> = {};
  const sources = [raw?.article_28_analysis, raw?.additional_clauses, raw?.findings];
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v !== "object") continue;
      buckets[k] = {
        status: (v as any).status,
        evidence: toArray<any>((v as any).evidence ?? (v as any).belege)
          .slice(0, 2)
          .map((e: any) => ({ quote: trimQuote(String(e?.quote ?? "")), page: Number.isInteger(e?.page) ? e.page : undefined })),
      };
    }
  }

  /* ---- In Zielstruktur legen ---- */
  for (const key of Object.keys(buckets)) {
    const node = buckets[key];
    if (A28_KEYS.has(key)) out.article_28_analysis[key] = node;
    else if (EXTRA_KEYS.has(key)) out.additional_clauses[key] = node;
  }

  /* ---- Actions vereinheitlichen ---- */
  const acts = [
    ...toArray<any>(raw?.recommended_actions),
    ...toArray<any>(raw?.actions),
  ];
  out.recommended_actions = acts.map(a => ({
    category: a.category ?? a.key ?? a.type ?? "",
    severity: a.severity ?? "medium",
    action: a.action ?? a.recommendation ?? a.suggested_clause ?? "",
  })).filter(a => a.category && a.action);

  /* ---- Compliance neu berechnen (deterministisch) ---- */
  let base = 0;
  const details: Record<string, number> = {};
  for (const [k, weight] of Object.entries(WEIGHTS)) {
    const status = out.article_28_analysis?.[k]?.status;
    const factor = STATUS_TO_FACTOR(status);
    const pts = weight * factor;
    details[k] = pts;
    base += pts;
  }

  /* ---- Bonus aus Zusatzklauseln ---- */
  let bonus = 0;
  const intl = out.additional_clauses?.international_transfers?.status;
  if (intl === "met") bonus += 5;
  else if (intl === "present") bonus += 3;
  else if (intl === "partial") bonus += 2;

  const liab = out.additional_clauses?.liability_cap?.status;
  if (liab === "met" || liab === "present") bonus += 2;

  const juris = out.additional_clauses?.jurisdiction?.status;
  if (juris === "met" || juris === "present") bonus += 2;

  /* ---- Korrekturen (Abzüge) nach Regelwerk ---- */
  let corrections = 0;
  const mediumOrHigh = out.recommended_actions.filter((a: any) => a.severity === "medium" || a.severity === "high").length;
  if (mediumOrHigh >= 3) corrections += 5;
  if (out.recommended_actions.some((a: any) => a.severity === "high")) corrections += 5;

  if (out.additional_clauses?.liability_cap?.status === "missing" || out.additional_clauses?.liability_cap?.status === "not_found") {
    corrections += 5;
  }
  if (out.additional_clauses?.international_transfers?.status === "missing") {
    corrections += 3;
  }

  const total = Math.max(0, Math.min(100, Math.round(base + bonus - corrections)));

  out.compliance_score.details = { ...details, bonus, penalties: 0, corrections };
  out.compliance_score.overall = total;

  /* ---- Risiko ableiten, Begründung beibehalten falls vorhanden ---- */
  const riskFromAgent = typeof raw?.risk_score?.overall === "number" ? raw.risk_score.overall : null;
  out.risk_score.overall = Number.isFinite(riskFromAgent) ? riskFromAgent : (100 - total);

  return out;
}

/* ========================= Stabilisierung / Normalisierung ========================= */
type Evidence = { quote: string; page?: number };
type Finding = { status?: string; evidence?: Evidence[]; belege?: Evidence[] };

const WEIGHTS: Record<string, number> = {
  instructions_only: 15,
  confidentiality: 10,
  security_TOMs: 20,
  subprocessors: 15,
  data_subject_rights_support: 10,
  breach_support: 10,
  deletion_return: 10,
  audit_rights: 10,
};

const CATEGORY_ORDER = [
  "instructions_only","confidentiality","security_TOMs","subprocessors",
  "data_subject_rights_support","breach_support","deletion_return","audit_rights",
  "international_transfers","liability_cap","jurisdiction",
];

const STATUS_FACTOR: Record<string, number> = {
  met: 1, erfüllt: 1,
  partial: 0.5, teilweise: 0.5,
  missing: 0, fehlt: 0,
  present: 1, // für Zusatzklauseln werten wir „vorhanden“ positiv (1), kann bei Bedarf angepasst werden
  "not_found": 0,
};

const CATEGORY_KEYWORDS: Record<string, RegExp> = {
  instructions_only: /weisung|instruction/i,
  confidentiality: /vertraulich|confidential/i,
  security_TOMs: /\bTOM|maßnahmen|security|art\.?\s?32/i,
  subprocessors: /unterauftrags|sub[- ]?processor/i,
  data_subject_rights_support: /betroffenenrechte|auskunft|löschung|widerspruch|art\.?\s?1[5-9]|22/i,
  breach_support: /verletzung|breach|meld(e|efrist)|art\.?\s?3[34]/i,
  deletion_return: /lösch|rückgab/i,
  audit_rights: /audit|nachweis|prüf/i,
  international_transfers: /scc|standardvertragsklausel|übermittl|transfer/i,
  liability_cap: /haftung/i,
  jurisdiction: /gericht|rechtswahl|gerichtsstand/i,
};

function statusToFactor(s?: string) {
  if (!s) return 0;
  const k = String(s).toLowerCase();
  if (k in STATUS_FACTOR) return STATUS_FACTOR[k as keyof typeof STATUS_FACTOR];
  return 0;
}

function normalizeParties(input: any): { rolle: string; name: string; land?: string }[] {
  const out: { rolle: string; name: string; land?: string }[] = [];
  const push = (rolle: string, name: string, land?: string) => {
    if (!/datenschutzbeauftragter/i.test(rolle)) out.push({ rolle, name, land });
  };

  const cm = input?.contract_metadata?.parties;
  if (Array.isArray(cm)) {
    cm.forEach((p: any) =>
      push(
        p?.role === "controller" ? "Verantwortlicher" :
        p?.role === "processor" ? "Auftragsverarbeiter" : (p?.role ?? ""),
        p?.name ?? "", p?.country ?? ""
      )
    );
  } else if (cm && typeof cm === "object") {
    if (cm.controller) push("Verantwortlicher", String(cm.controller));
    if (cm.processor) push("Auftragsverarbeiter", String(cm.processor), cm.country || cm.processor_country);
    // DPO bewusst nicht
  }
  const legacy = input?.parties;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    if (legacy.controller) push("Verantwortlicher", String(legacy.controller));
    if (legacy.processor) push("Auftragsverarbeiter", String(legacy.processor));
  }
  return out;
}

function stabilizeActions(actions: any[]): { category: string; severity: "low" | "medium" | "high"; action: string }[] {
  const mapped = (actions ?? []).map((a: any) => {
    let category = a?.category;
    if (!category) {
      const text = `${a?.action ?? ""} ${a?.issue ?? ""}`;
      const hit = Object.entries(CATEGORY_KEYWORDS).find(([, rx]) => rx.test(text));
      category = hit?.[0] ?? "audit_rights";
    }
    const sev: "low" | "medium" | "high" =
      a?.severity === "high" || a?.severity === "medium" || a?.severity === "low" ? a.severity : "medium";
    return { category, severity: sev, action: String(a?.action ?? a?.suggested_clause ?? a?.issue ?? "").trim() };
  });

  const sevRank = (s: string) => (s === "high" ? 0 : s === "medium" ? 1 : 2);
  const catRank = (c: string) => CATEGORY_ORDER.indexOf(c);
  return mapped.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || catRank(a.category) - catRank(b.category));
}

function computeCompliance(a28: Record<string, Finding>, extras: any, details?: Record<string, number>) {
  let base = 0;
  for (const key of Object.keys(WEIGHTS)) {
    base += WEIGHTS[key] * statusToFactor(a28?.[key]?.status);
  }
  // Bonus/Abzüge: Details bevorzugt, sonst Heuristik über Zusatzklauseln
  let bonus = 0, penalties = 0;
  if (details) {
    bonus += Number(details.bonus ?? 0);
    penalties += Number(details.penalties ?? 0);
    const corr = Number(details.corrections ?? 0);
    if (corr < 0) penalties += -corr;
  } else if (extras) {
    const intl = extras?.international_transfers?.status;
    if (["met","present","erfüllt"].includes(String(intl).toLowerCase())) bonus += 5;
    else if (["partial","teilweise"].includes(String(intl).toLowerCase())) bonus += 2;

    const liab = extras?.liability_cap?.status;
    if (["met","present","erfüllt"].includes(String(liab).toLowerCase())) bonus += 2;

    const juris = extras?.jurisdiction?.status;
    if (["met","present","erfüllt"].includes(String(juris).toLowerCase())) bonus += 1;
  }
  const overall = Math.max(0, Math.min(100, Math.round(base + bonus - penalties)));
  return { overall, base: Math.round(base), bonus: Math.round(bonus), penalties: Math.round(penalties) };
}

function reconcileFinal(json: any) {
  const out = { ...json };

  // Parties → konsistentes Array (ohne DSB)
  const parties = normalizeParties(out);
  out.contract_metadata = out.contract_metadata ?? {};
  out.contract_metadata.parties = parties;

  // Ensure article_28_analysis & additional_clauses objects exist
  out.article_28_analysis = out.article_28_analysis ?? {};
  out.additional_clauses = out.additional_clauses ?? {};

  // Compliance rechnerisch neu
  const comp = computeCompliance(out.article_28_analysis, out.additional_clauses, out.compliance_score?.details);
  out.compliance_score = {
    overall: comp.overall,
    details: {
      instructions_only: WEIGHTS.instructions_only * statusToFactor(out.article_28_analysis?.instructions_only?.status),
      confidentiality: WEIGHTS.confidentiality * statusToFactor(out.article_28_analysis?.confidentiality?.status),
      security_TOMs: WEIGHTS.security_TOMs * statusToFactor(out.article_28_analysis?.security_TOMs?.status),
      subprocessors: WEIGHTS.subprocessors * statusToFactor(out.article_28_analysis?.subprocessors?.status),
      data_subject_rights_support:
        WEIGHTS.data_subject_rights_support * statusToFactor(out.article_28_analysis?.data_subject_rights_support?.status),
      breach_support: WEIGHTS.breach_support * statusToFactor(out.article_28_analysis?.breach_support?.status),
      deletion_return: WEIGHTS.deletion_return * statusToFactor(out.article_28_analysis?.deletion_return?.status),
      audit_rights: WEIGHTS.audit_rights * statusToFactor(out.article_28_analysis?.audit_rights?.status),
      bonus: comp.bonus,
      penalties: comp.penalties,
      corrections: 0,
    },
  };

  // Risk fallback
  if (!out.risk_score || typeof out.risk_score?.overall !== "number") {
    out.risk_score = {
      overall: Math.max(0, 100 - out.compliance_score.overall),
      rationale: out.risk_score?.rationale ?? "Risiko aus Compliance abgeleitet (100 − Compliance).",
    };
  }

  // Actions stabilisieren
  out.recommended_actions = stabilizeActions(out.recommended_actions);

  // Version-Tag
  out.version = "2025-10-31-stable1";
  return out;
}

/* ========================= Agent ========================= */
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
`,
  // deterministischer: temperature 0, topP 0 (falls Agents-API topP=0 erlaubt; sonst 1)
  modelSettings: { temperature: 0, topP: 0, maxTokens: 4000, store: false },
});

/* ========================= POST ========================= */
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

    // 1) Chunking
    const chunks = semanticChunkText(inputText, 8_000, 9_500);

    const runner = new Runner();
    const partialResults: any[] = [];

    // 2) Chunk-Analyse
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

    // 3) Merge
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

    // 4) Parse & Reconcile (HARTE STABILISIERUNG)
    const finalJson = extractJson(merged.finalOutput);

    // ZWINGE Konsistenz & fixe Scores:
    const reconciled = reconcileAndScore(finalJson);

    return NextResponse.json(reconciled);
  } catch (e: any) {
    return NextResponse.json(
      { error: "Agent-Serverfehler", details: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}

/* ========================= Backoff ========================= */
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
      delay *= 2;
    }
  }
  throw new Error("Backoff failed.");
}