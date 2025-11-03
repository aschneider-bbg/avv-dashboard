/* lib/avv-scoring.ts
 * Deterministische AVV-Bewertung (hart kodiert nach Excel-Logik)
 * - Gewichte (Art. 28) gem. Bewertungs-Tab
 * - Bonus (SCC/Transfers, Haftung, Gerichtsstand)
 * - Korrekturen (Issues, fehlende Haftung/Transfers)
 */

type Evidence = { quote: string; page?: number };
type Finding = { status?: string; evidence?: Evidence[]; belege?: Evidence[] };

export type AvvInput = any;

export type Reconciled = {
  executive_summary: string;
  contract_metadata: {
    title: string;
    date: string;
    parties: Array<{ rolle: string; name: string; land?: string }>;
    processor_dpo?: string;
  };
  article_28_analysis: Record<string, { status?: string; evidence: Evidence[] }>;
  additional_clauses: Record<string, { status?: string; evidence: Evidence[] }>;
  recommended_actions: Array<{ category: string; severity: "high" | "medium" | "low"; action: string }>;
  compliance_score: { overall: number; details: Record<string, number> };
  risk_score: { overall: number; rationale: string };
  version: string;
};

/* ===== Excel-Logik (hart kodiert) ===== */

/** Gewichte Art. 28 (Summe 100) – Excel „Bewertung AVV“ */
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

/** Status → Faktor (Excel: met=1, partial=0.5, missing=0) */
const STATUS_TO_FACTOR = (s?: string) => {
  const v = (s || "").toLowerCase();
  if (v === "met" || v === "erfüllt") return 1;
  if (v === "partial" || v === "teilweise") return 0.5;
  return 0;
};

/** Zusatzklauseln, die Bonus/Abzüge triggern */
const EXTRA_KEYS = new Set(["international_transfers", "liability_cap", "jurisdiction"]);
/** Art. 28 Schlüssel (für Details) */
const A28_KEYS = new Set(Object.keys(WEIGHTS));

/* ===== kleine Utils ===== */

const isArray = (v: any): v is any[] => Array.isArray(v);
const toArray = <T,>(v: any): T[] => (Array.isArray(v) ? v : []);
const trimQuote = (s: string) => s.replace(/\s+/g, " ").slice(0, 240);

/* ===== Normalisierung & Scoring ===== */

/**
 * Vereinheitlicht beliebige Agent-Ausgaben (verschiedene Schemas)
 * und berechnet deterministisch Scores gemäß Excel-Logik.
 */
export function reconcileAndScore(raw: AvvInput): Reconciled {
  const out: Reconciled = {
    executive_summary: (raw?.executive_summary ?? "").toString(),
    contract_metadata: {
      title: raw?.contract_metadata?.title ?? "",
      date: raw?.contract_metadata?.date ?? "",
      parties: normalizeParties(raw?.contract_metadata?.parties ?? raw?.parties),
    },
    article_28_analysis: {},
    additional_clauses: {},
    recommended_actions: normalizeActions(raw),
    compliance_score: { overall: 0, details: {} },
    risk_score: {
      overall: 0,
      rationale: (raw?.risk_score?.rationale ?? "").toString(),
    },
    version: "2025-10-31-excel-aligned",
  };

  // Findings aus article_28_analysis, findings, additional_clauses zusammenziehen
  const buckets: Record<string, { status?: string; evidence: Evidence[] }> = {};
  const sources = [raw?.article_28_analysis, raw?.additional_clauses, raw?.findings];
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v !== "object") continue;
      const ev = toArray<any>((v as any).evidence ?? (v as any).belege)
        .slice(0, 2)
        .map((e) => ({
          quote: trimQuote(String(e?.quote ?? "")),
          page: Number.isInteger(e?.page) ? e.page : undefined,
        }))
        .filter((e) => e.quote);
      buckets[k] = { status: (v as any).status, evidence: ev };
    }
  }

  // In Zielstrukturen ablegen
  for (const key of Object.keys(buckets)) {
    if (A28_KEYS.has(key)) out.article_28_analysis[key] = buckets[key];
    else if (EXTRA_KEYS.has(key)) out.additional_clauses[key] = buckets[key];
  }

  // ==== Excel-Scoring ====
  let base = 0;
  const details: Record<string, number> = {};
  for (const [k, weight] of Object.entries(WEIGHTS)) {
    const status = out.article_28_analysis?.[k]?.status;
    const factor = STATUS_TO_FACTOR(status);
    const pts = weight * factor;
    details[k] = pts;
    base += pts;
  }

  // Bonus (Excel: max +10, am Ende Deckel 100/min 0)
  let bonus = 0;
  const intl = out.additional_clauses?.international_transfers?.status;
  if (intl === "met") bonus += 5;
  else if (intl === "present") bonus += 3;
  else if (intl === "partial") bonus += 2;

  const liab = out.additional_clauses?.liability_cap?.status;
  if (liab === "met" || liab === "present") bonus += 2;

  const juris = out.additional_clauses?.jurisdiction?.status;
  if (juris === "met" || juris === "present") bonus += 2;

  // Korrekturen (Abzüge) – Excel-„Kalibrierung“
  let corrections = 0;
  const issues = out.recommended_actions;
  const mediumOrHigh = issues.filter((a) => a.severity === "medium" || a.severity === "high").length;
  if (mediumOrHigh >= 3) corrections += 5;
  if (issues.some((a) => a.severity === "high")) corrections += 5;
  if (liab === "missing" || liab === "not_found") corrections += 5;
  if (intl === "missing") corrections += 3;

  const total = clamp0_100(Math.round(base + bonus - corrections));

  out.compliance_score.details = {
    ...details,
    bonus,
    penalties: 0,
    corrections,
  };
  out.compliance_score.overall = total;

  // Risiko: Agent-Wert bevorzugen, sonst aus Compliance ableiten
  const riskFromAgent = typeof raw?.risk_score?.overall === "number" ? raw.risk_score.overall : null;
  out.risk_score.overall = Number.isFinite(riskFromAgent) ? riskFromAgent : (100 - total);

  // (Optional) kurze Rationale ergänzen, wenn leer
  if (!out.risk_score.rationale) {
    out.risk_score.rationale = buildDefaultRiskRationale(out);
  }

  return out;
}

/* ===== Exportierte Hilfen für Frontend ===== */

export function buildComplianceTooltip(a28: Reconciled["article_28_analysis"], details: Record<string, number>) {
  const lines: string[] = [];
  let base = 0;
  for (const key of Object.keys(WEIGHTS)) {
    const w = WEIGHTS[key];
    const st = a28?.[key]?.status ?? "";
    const f = STATUS_TO_FACTOR(st);
    const pts = w * f;
    base += pts;
    const stDe = st === "met" ? "erfüllt" : st === "partial" ? "teilweise" : st === "missing" ? "fehlt" : (st || "—");
    lines.push(`• ${labelDE(key)}: ${w} × ${fmt(f)} = ${fmt(pts)} (${stDe})`);
  }
  const bonus = details?.bonus ?? 0;
  const corr = details?.corrections ?? 0;
  const total = clamp0_100(Math.round(base + bonus - corr));
  return `Begründung Compliance\n\n${lines.join("\n")}\n\nBonus: +${fmt(bonus)}   Abzüge: −${fmt(corr)}\nGesamt: ${fmt(base)} + ${fmt(bonus)} − ${fmt(corr)} = ${fmt(total)} / 100`;
}

export function labelDE(key: string): string {
  const map: Record<string, string> = {
    instructions_only: "Weisung (nur dokumentierte Weisung)",
    confidentiality: "Vertraulichkeit",
    security_TOMs: "Technisch-organisatorische Maßnahmen",
    subprocessors: "Unterauftragsverarbeiter",
    data_subject_rights_support: "Unterstützung Betroffenenrechte",
    breach_support: "Unterstützung bei Datenschutzverletzungen",
    deletion_return: "Löschung/Rückgabe nach Vertragsende",
    audit_rights: "Audit- und Nachweisrechte",
    international_transfers: "Internationale Übermittlungen",
    liability_cap: "Haftungsregel/Haftungsbegrenzung",
    jurisdiction: "Gerichtsstand/Rechtswahl",
  };
  return map[key] ?? key.replace(/_/g, " ");
}

/* ===== interne Helfer ===== */

function clamp0_100(n: number) {
  return Math.max(0, Math.min(100, n));
}

function fmt(n: number) {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

function normalizeParties(input: any): Array<{ rolle: string; name: string; land?: string }> {
  if (!input) return [];
  // A) bereits Array
  if (isArray(input)) {
    return input
      .map((p) => ({
        rolle: p?.rolle ?? p?.role ?? "",
        name: p?.name ?? "",
        land: p?.land ?? p?.country ?? undefined,
      }))
      .filter((p) => p.name);
  }
  // B) Objekt {controller, processor, country, processor_dpo}
  if (typeof input === "object") {
    const out: Array<{ rolle: string; name: string; land?: string }> = [];
    if (input.controller) out.push({ rolle: "Verantwortlicher", name: String(input.controller), land: input.country || "DE" });
    if (input.processor) out.push({ rolle: "Auftragsverarbeiter", name: String(input.processor), land: input.country || "DE" });
    // DSB nicht als Partei zurückgeben
    return out;
  }
  return [];
}

function normalizeActions(raw: any): Array<{ category: string; severity: "high" | "medium" | "low"; action: string }> {
  const acts = [...toArray<any>(raw?.recommended_actions), ...toArray<any>(raw?.actions)];
  return acts
    .map((a) => ({
      category: a.category ?? a.key ?? a.type ?? "",
      severity: (a.severity ?? "medium") as "high" | "medium" | "low",
      action: a.action ?? a.recommendation ?? a.suggested_clause ?? "",
    }))
    .filter((a) => a.category && a.action);
}

function buildDefaultRiskRationale(r: Reconciled): string {
  const c = r.compliance_score.overall;
  if (c >= 85) return "Niedriges Restrisiko: Kernpflichten sind weitgehend erfüllt; nur punktuelle Verbesserungen empfohlen.";
  if (c >= 70) return "Begrenztes Restrisiko: gute Grundlage mit einzelnen Lücken (Betroffenenrechte/Löschung/Haftung).";
  if (c >= 50) return "Erhöhtes Risiko: mehrere relevante Lücken; Maßnahmen zu Rechten, Löschung und Haftung priorisieren.";
  return "Hohes Risiko: zentrale Pflichten fehlen; klare Nachbesserungen in Kernklauseln erforderlich.";
}