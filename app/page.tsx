"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/** ===== Utils ===== */
const isNum = (v: any): v is number => typeof v === "number" && !Number.isNaN(v);

/** ===== AVV Utils (konfliktfrei, eindeutige Namen) ===== */

// Gewichte gemäß deines Schemas (Summe 100)
const avv_WEIGHTS: Record<string, number> = {
  instructions_only: 15,
  confidentiality: 10,
  security_TOMs: 20,
  subprocessors: 15,
  data_subject_rights_support: 10,
  breach_support: 10,
  deletion_return: 10,
  audit_rights: 10,
};

// DE-Labels für die Kategorien
const avv_LABELS_DE: Record<string, string> = {
  instructions_only: "Weisung (nur dokumentierte Weisung)",
  confidentiality: "Vertraulichkeit",
  security_TOMs: "Technisch-organisatorische Maßnahmen",
  subprocessors: "Unterauftragsverarbeiter",
  data_subject_rights_support: "Unterstützung Betroffenenrechte",
  breach_support: "Unterstützung bei Datenschutzverletzungen",
  deletion_return: "Löschung/Rückgabe nach Vertragsende",
  audit_rights: "Audit- und Nachweisrechte",
  bonus: "Bonus",
  penalties: "Abzüge",
  corrections: "Korrekturen",
};

// defensiv, kollisionsfrei
const avv_num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const avv_fmt = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

// Status → Faktor (met=1, partial=0.5, missing=0)
const avv_statusToFactor = (s?: string): number => {
  if (!s) return 0;
  const k = s.toLowerCase();
  if (k === "met" || k === "erfüllt") return 1;
  if (k === "partial" || k === "teilweise") return 0.5;
  return 0;
};

const fmt = (n: number) => Number.isInteger(n) ? `${n}` : n.toFixed(1);

/** Labels für Compliance-Details (Agent liefert keys in EN) */
const DETAILS_LABELS: Record<string, string> = {
  instructions_only: "Weisung (nur auf dokumentierte Weisung)",
  confidentiality: "Vertraulichkeit",
  security_TOMs: "Technisch-organisatorische Maßnahmen",
  subprocessors: "Unterauftragsverarbeiter",
  data_subject_rights_support: "Unterstützung Betroffenenrechte",
  breach_support: "Unterstützung bei Datenschutzverletzungen",
  deletion_return: "Löschung/Rückgabe nach Vertragsende",
  audit_rights: "Audit- und Nachweisrechte",
  bonus: "Bonus",
  penalties: "Abzüge",
  corrections: "Korrekturen",
};

/** Baut den verständlichen Compliance-Tooltip: Gewicht × Faktor = Punkte, dann Bonus/Abzüge, Summe */
function avv_buildComplianceTooltip(
  a28: Record<string, { status?: string }>,
  extras: Record<string, any> | undefined,
  details: Record<string, any> | undefined
): string {
  const order = Object.keys(avv_WEIGHTS);
  const lines: string[] = [];
  let base = 0;

  for (const key of order) {
    const weight = avv_WEIGHTS[key];
    const status = a28?.[key]?.status ?? "";
    const f = avv_statusToFactor(status);
    const pts = weight * f;
    base += pts;

    const statusDe =
      status?.toLowerCase() === "met" ? "erfüllt" :
      status?.toLowerCase() === "partial" ? "teilweise" :
      status?.toLowerCase() === "missing" ? "fehlt" : (status || "—");

    lines.push(`• ${avv_LABELS_DE[key]}: ${weight} × ${avv_fmt(f)} = ${avv_fmt(pts)}  (${statusDe})`);
  }

  // Bonus/Abzüge: zuerst Backend-Details, sonst Heuristik (Fallback)
  let bonus = avv_num(details?.bonus) ?? 0;
  let abzug = 0;
  const p1 = avv_num(details?.penalties);
  const p2 = avv_num(details?.corrections);
  if (p1) abzug += p1;
  if (p2) abzug += Math.abs(p2);

  if (!details) {
    const intl = extras?.["internationale_übermittlungen"]?.status;
    if (intl === "erfüllt") bonus += 5; else if (intl === "teilweise") bonus += 2; else if (intl === "vorhanden") bonus += 3;
    const liab = extras?.["haftungsbegrenzung"]?.status;
    if (liab === "erfüllt" || liab === "vorhanden") bonus += 2;
    const juris = extras?.["gerichtsstand_recht"]?.status;
    if (juris === "erfüllt" || juris === "vorhanden") bonus += 2;
  }

  const total = Math.max(0, Math.min(100, Math.round(base + bonus - abzug)));

  return (
`Begründung Compliance

${lines.join("\n")}

${avv_LABELS_DE.bonus}: +${avv_fmt(bonus)}   ${avv_LABELS_DE.penalties}: −${avv_fmt(abzug)}
Gesamt: ${avv_fmt(base)} + ${avv_fmt(bonus)} − ${avv_fmt(abzug)} = ${avv_fmt(total)} / 100`
  );
}

/** Risiko-Tooltip: Rationale + (falls ableitbar) Hinweis 100 − Compliance */
function avv_buildRiskTooltip(
  riskOverall: number | null | undefined,
  rationale: string | null | undefined,
  complianceOverall: number | null | undefined
): string {
  const rationaleText = (rationale || "—").trim();
  const derived = typeof complianceOverall === "number"
    ? `\n\nHinweis: Risiko ≈ 100 − Compliance → ${100 - complianceOverall}`
    : "";
  const head = "Begründung Risiko";
  const scoreLine = typeof riskOverall === "number" ? `\nScore: ${riskOverall}/100` : "";
  return `${head}\n\n${rationaleText}${scoreLine}${derived}`.trim();
}

/** Baut den Tooltip-Text für die Compliance-Details hübsch zusammen */
function buildComplianceDetailsTooltip(details?: Record<string, any>) {
  if (!details || typeof details !== "object") return "—";
  const order = [
    "instructions_only",
    "confidentiality",
    "security_TOMs",
    "subprocessors",
    "data_subject_rights_support",
    "breach_support",
    "deletion_return",
    "audit_rights",
    "bonus",
    "penalties",
    "corrections",
  ];
  const lines: string[] = [];
  for (const k of order) {
    if (k in details && isNum(details[k])) {
      const label = DETAILS_LABELS[k] ?? k.replace(/_/g, " ");
      const val = details[k];
      lines.push(`${label}: ${val}`);
    }
  }
  if (lines.length === 0) return "—";
  return `Begründung Compliance\n\n${lines.map(l => `• ${l}`).join("\n")}`;
}

// oben im Component-Body, nachdem data/compliance/risk berechnet wurden:
const complianceTooltip = avv_buildComplianceTooltip(
  data?.a28 || {},
  data?.extras || {},
  raw?.compliance_score?.details
);
const riskTooltip = avv_buildRiskTooltip(
  typeof raw?.risk_score?.overall === "number" ? raw.risk_score.overall : (typeof risk === "number" ? risk : null),
  raw?.risk_score?.rationale || data?.riskRationale || "",
  typeof compliance === "number" ? compliance : null
);

/* ---------- Hilfsfunktionen (robust) ---------- */
const toArray = <T,>(v: any): T[] => (Array.isArray(v) ? v : []);


/* ---------- Typen ---------- */
type Evidence = { quote: string; page?: number };

const ART28_LABELS: Record<string, string> = {
  weisung: "Weisung",
  vertraulichkeit: "Vertraulichkeit",
  toms: "TOMs",
  unterauftragsverarbeiter: "Subprozessoren",
  betroffenenrechte: "Betroffenenrechte",
  vorfallmeldung: "Breach-Unterstützung",
  löschung_rückgabe: "Löschung/Rückgabe",
  audit_nachweis: "Audit/Nachweis",
};

const EN_TO_CANON: Record<string, keyof typeof ART28_LABELS> = {
  instructions_only: "weisung",
  confidentiality: "vertraulichkeit",
  security_TOMs: "toms",
  subprocessors: "unterauftragsverarbeiter",
  data_subject_rights_support: "betroffenenrechte",
  breach_support: "vorfallmeldung",
  deletion_return: "löschung_rückgabe",
  audit_rights: "audit_nachweis",
};

const STATUS_EN_TO_DE: Record<string, "erfüllt" | "teilweise" | "fehlt" | "vorhanden" | "nicht gefunden"> = {
  met: "erfüllt",
  partial: "teilweise",
  missing: "fehlt",
  present: "vorhanden",
  "not_found": "nicht gefunden",
};

const ACTION_CATEGORY_DE: Record<string, string> = {
  instructions_only: "Weisung (nur auf dokumentierte Weisung)",
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

function mapStatus(v?: string) {
  if (!v) return undefined;
  const low = v.toLowerCase();
  return (
    STATUS_EN_TO_DE[low] ||
    (["erfüllt", "teilweise", "fehlt", "vorhanden", "nicht gefunden"] as const).find((x) => x === low) ||
    undefined
  );
}

function labelForCategory(key: string) {
  return ACTION_CATEGORY_DE[key] ?? key.replace(/_/g, " ");
}

/* ---------- Normalisierung (robust gegen alle Varianten) ---------- */
function normalize(input: any) {
  const executiveSummary: string = (input?.executive_summary ?? "").toString();

  const meta =
    input?.vertrag_metadata ??
    (input?.contract_metadata
      ? {
          titel: input.contract_metadata.title ?? "",
          datum: input.contract_metadata.date ?? "",
        }
      : { titel: "", datum: "" });

  // Parteien – A: contract_metadata.parties[]
  const partiesA = toArray<any>(input?.contract_metadata?.parties).map((p) => ({
    rolle:
      p?.role === "controller"
        ? "Verantwortlicher"
        : p?.role === "processor"
        ? "Auftragsverarbeiter"
        : (p?.role ?? ""),
    name: p?.name ?? "",
    land: p?.country ?? "",
  }));

  // Parteien – B: eigenes Objekt {controller, processor, processor_dpo}
  const partiesB: { rolle: string; name: string; land?: string }[] = [];
  if (input?.parties && typeof input.parties === "object" && !Array.isArray(input.parties)) {
    const p = input.parties;
    if (p.controller) partiesB.push({ rolle: "Verantwortlicher", name: String(p.controller) });
    if (p.processor) partiesB.push({ rolle: "Auftragsverarbeiter", name: String(p.processor) });
    if (p.processor_dpo) partiesB.push({ rolle: "Datenschutzbeauftragter (AV)", name: String(p.processor_dpo) });
  }
 
  // Parteien – C: contract_metadata.parties als Objekt {controller, processor, country, processor_dpo}
  const partiesC: { rolle: string; name: string; land?: string }[] = [];
  const pc = input?.contract_metadata?.parties;
  if (pc && typeof pc === "object" && !Array.isArray(pc)) {
    if (pc.controller) {
      partiesC.push({ rolle: "Verantwortlicher", name: String(pc.controller) });
    }
    if (pc.processor) {
      const land = pc.country || pc.processor_country || "";
      partiesC.push({ rolle: "Auftragsverarbeiter", name: String(pc.processor), land });
    }
    if (pc.processor_dpo) {
      partiesC.push({ rolle: "Datenschutzbeauftragter (AV)", name: String(pc.processor_dpo) });
    }
  }

  const parties = [...partiesA, ...partiesB, ...partiesC].filter(
  (p) => !/^datenschutzbeauftragter/i.test(p.rolle || "")
);

  // Art. 28
  const a28src = input?.prüfung?.art_28 ?? input?.findings?.art_28 ?? input?.article_28_analysis ?? {};
  const a28: Record<string, { status?: string; belege: Evidence[] }> = {};
  // Deutsch-Kanon → direkt
  Object.keys(ART28_LABELS).forEach((k) => {
    const node = a28src?.[k];
    if (node && typeof node === "object") {
      a28[k] = {
        status: mapStatus(node.status) ?? node.status,
        belege: toArray<Evidence>(node.belege ?? node.evidence),
      };
    }
  });
  // Englisch → Kanon
  Object.keys(a28src || {}).forEach((k) => {
    const canon = EN_TO_CANON[k];
    if (canon && !a28[canon]) {
      const node = a28src[k];
      if (node && typeof node === "object") {
        a28[canon] = {
          status: mapStatus(node.status) ?? node.status,
          belege: toArray<Evidence>(node.evidence ?? node.belege),
        };
      }
    }
  });

  // Zusatzklauseln
  const extrasSrc = input?.prüfung?.zusatzklauseln ?? input?.findings?.additional_clauses ?? input?.additional_clauses ?? {};
  const extrasMap = {
    internationale_übermittlungen: extrasSrc?.internationale_übermittlungen ?? extrasSrc?.international_transfers,
    haftungsbegrenzung: extrasSrc?.haftungsbegrenzung ?? extrasSrc?.liability_cap,
    gerichtsstand_recht: extrasSrc?.gerichtsstand_recht ?? extrasSrc?.jurisdiction,
  };
  const extras: Record<string, { status?: string; belege: Evidence[] }> = {};
  Object.entries(extrasMap).forEach(([k, v]) => {
    if (v && typeof v === "object") {
      extras[k] = {
        status: mapStatus((v as any).status) ?? (v as any).status,
        belege: toArray<Evidence>((v as any).belege ?? (v as any).evidence),
      };
    }
  });

  // Scores
  const riskOverall =
    isNum(input?.risiko_score?.gesamt) ? input.risiko_score.gesamt :
    isNum(input?.risk_score?.overall) ? input.risk_score.overall : null;

  const riskRationale = (input?.risk_rationale ?? input?.risk_score?.rationale ?? "").toString();

  const actions = toArray<any>(input?.recommended_actions ?? input?.actions);

  return { executiveSummary, meta, parties, a28, extras, riskOverall, riskRationale, actions, raw: input };
}

/* ---------- Komponente ---------- */
export default function Page() {
  const [raw, setRaw] = useState<any>(null);
  const [data, setData] = useState<ReturnType<typeof normalize> | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [showRaw, setShowRaw] = useState(false);

  const chartRef = useRef<HTMLCanvasElement | null>(null);
  const chartInst = useRef<any>(null);

  /* ---- KPIs ---- */
  const kpis = useMemo(() => {
    const src = data?.a28 ?? {};
    const statuses = Object.values(src).map((x: any) => x?.status || "");
    const erfüllt = statuses.filter((s) => s === "erfüllt").length;
    const teilweise = statuses.filter((s) => s === "teilweise").length;
    const fehlt = statuses.filter((s) => s === "fehlt").length;
    const total = Object.keys(ART28_LABELS).length;
    return { erfüllt, teilweise, fehlt, total, any: erfüllt + teilweise + fehlt > 0 };
  }, [data]);


    const providedCompliance: number | null = isNum(raw?.compliance_score?.overall) ? raw.compliance_score.overall : null;
  /* ---- Compliance/Risk ---- */
  const complianceMatrix = useMemo(() => {
    if (!kpis.any) return null;
    const achieved = kpis.erfüllt * 1 + kpis.teilweise * 0.5;
    let score = (achieved / kpis.total) * 100;

    const ex = data?.extras || {};
    const intl = ex["internationale_übermittlungen"]?.status;
    if (intl === "erfüllt") score += 10;
    else if (intl === "teilweise") score += 5;
    else if (intl === "vorhanden") score += 3;

    const liab = ex["haftungsbegrenzung"]?.status;
    if (liab === "erfüllt" || liab === "vorhanden") score += 3;

    const juris = ex["gerichtsstand_recht"]?.status;
    if (juris === "erfüllt" || juris === "vorhanden") score += 2;

    return Math.max(0, Math.min(100, Math.round(score)));
  }, [kpis, data?.extras]);

  // Falls Backend "overall" eigentlich ein Compliance-Score ist:
  const agentOverall: number | null = isNum(raw?.risk_score?.overall) ? raw.risk_score.overall : null;
  const rationaleText = (data?.riskRationale || "").toLowerCase();
  const mentionsPositive = ["wesentlichen anforderungen", "weitgehend erfüllt", "konform", "erfüllt", "entspricht art. 28"]
    .some((t) => rationaleText.includes(t));
  const isLikelyComplianceScore = agentOverall != null && agentOverall >= 60 && mentionsPositive;

//   const compliance = isLikelyComplianceScore ? agentOverall : complianceMatrix;
//   const risk = isLikelyComplianceScore
//     ? (compliance != null ? Math.max(0, 100 - (compliance as number)) : null)
//     : (isNum(data?.riskOverall) ? (data!.riskOverall as number)
//        : (agentOverall != null ? agentOverall : (compliance != null ? Math.max(0, 100 - (compliance as number)) : null)));

  // Compliance: wenn der Agent einen offiziellen Wert liefert -> immer diesen nehmen.
  const compliance =
    providedCompliance ??
    (isLikelyComplianceScore ? agentOverall : complianceMatrix);

  // Risiko: wenn der Agent einen offiziellen Risiko-Score liefert -> nutzen,
  // sonst als 100 - Compliance ableiten (falls vorhanden).
  const risk =
    isNum(raw?.risk_score?.overall)
      ? (raw!.risk_score!.overall as number)
      : (compliance != null ? Math.max(0, 100 - (compliance as number)) : null);

  const compColor = compliance == null ? "text-secondary" : compliance >= 85 ? "text-success" : compliance >= 70 ? "text-warning" : "text-danger";
  const riskColor = risk == null ? "text-secondary" : risk <= 20 ? "text-success" : risk <= 40 ? "text-warning" : "text-danger";
  const compLabel = compliance == null ? "—" : compliance >= 85 ? "Hervorragend" : compliance >= 70 ? "Solide" : compliance >= 50 ? "Kritisch" : "Schlecht";
  const riskLabel = risk == null ? "—" : risk <= 15 ? "Sehr gering" : risk <= 30 ? "Begrenzt" : risk <= 60 ? "Erhöht" : "Hoch";

  // Tooltips nur innerhalb des Components berechnen (damit data/raw im Scope sind)
const complianceTooltip = useMemo(() => {
  return avv_buildComplianceTooltip(
    data?.a28 || {},
    data?.extras || {},
    raw?.compliance_score?.details
  );
}, [data?.a28, data?.extras, raw?.compliance_score?.details]);

const riskTooltip = useMemo(() => {
  const riskOverall =
    typeof raw?.risk_score?.overall === "number"
      ? raw.risk_score.overall
      : typeof risk === "number"
      ? risk
      : null;

  const rationale = raw?.risk_score?.rationale || data?.riskRationale || "";
  const complianceOverall = typeof compliance === "number" ? compliance : null;

  return avv_buildRiskTooltip(riskOverall, rationale, complianceOverall);
}, [raw?.risk_score, data?.riskRationale, compliance]);

  /* ---- Chart stabilisieren ---- */
  const donut = useMemo<number[]>(() => [kpis.erfüllt, kpis.teilweise, kpis.fehlt], [kpis]);
  useEffect(() => {
    const Chart = (window as any).Chart as any;
    if (!Chart || !chartRef.current) return;

    if (chartInst.current) {
      try { chartInst.current.destroy(); } catch {}
      chartInst.current = null;
    }

    if (!data || !kpis.any || !Array.isArray(donut) || donut.length !== 3) return;

    chartInst.current = new Chart(chartRef.current, {
      type: "doughnut",
      data: {
        labels: ["erfüllt", "teilweise", "fehlt"],
        datasets: [
          {
            data: donut,
            backgroundColor: ["#16a34a", "#f59e0b", "#ef4444"],
            borderColor: "#0b0e14",
            borderWidth: 2,
            hoverOffset: 6,
          },
        ],
      },
      options: {
        plugins: {
          legend: { position: "bottom", labels: { color: "#f1f4fa" } },
          tooltip: { enabled: true },
        },
        cutout: "65%",
      },
    });
  }, [donut, data, kpis.any]);

  /* ---- Upload ---- */
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    setLoading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/agent-avv", { method: "POST", body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = (json?.details || json?.error || res.statusText || "Unbekannter Fehler").toString();
        throw new Error(detail);
      }
      setRaw(json);
      setData(normalize(json));
    } catch (e: any) {
      // zeigt die echte Fehlermeldung aus der Route an
      setErr(String(e?.message || e));
      setRaw(null);
      setData(null);
    } finally {
      setLoading(false);
      if (e.target) e.target.value = "";
      setInputKey((k) => k + 1);
    }
  };

  const renderEvidence = (ev?: Evidence[]) =>
    toArray<Evidence>(ev).map((e) => `S.${e.page ?? "?"}: „${(e.quote || "").slice(0, 140)}…“`).join(" • ");

  const badge = (s?: string) => {
    if (s === "erfüllt") return <span className="badge" style={{ background: "#14532d" }}>erfüllt</span>;
    if (s === "teilweise") return <span className="badge" style={{ background: "#7c2d12" }}>teilweise</span>;
    if (s === "fehlt") return <span className="badge" style={{ background: "#7f1d1d" }}>fehlt</span>;
    if (s === "vorhanden") return <span className="badge bg-primary">vorhanden</span>;
    if (s === "nicht gefunden") return <span className="badge bg-secondary">nicht gefunden</span>;
    return <span className="badge bg-secondary">—</span>;
  };

  const summaryText = (data?.executiveSummary || "").trim() || (data?.riskRationale || "—");

  return (
    <div className="container py-4">
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between mb-3">
        <div>
          <h1 className="h3 mb-1">AVV-Check Dashboard</h1>
          <div className="muted">Automatisierte Prüfung nach DSGVO Art. 28 Abs. 3</div>
        </div>
        <div className="d-flex gap-2">
          <span className="chip"><i className="bi bi-shield-lock" /> DSGVO</span>
          <span className="chip"><i className="bi bi-cpu" /> GPT</span>
        </div>
      </div>

      {/* Upload + KPIs */}
      <div className="card mb-4">
        <div className="card-body">
          <div className="d-flex flex-wrap align-items-center justify-content-between">
            <div className="upload w-100 mb-3 mb-md-0" style={{ maxWidth: 520 }}>
              <input key={inputKey} type="file" className="form-control" accept=".pdf" onChange={onUpload} />
              {loading && (
                <div className="mt-2 d-flex align-items-center gap-2">
                  <div className="spinner-border spinner-border-sm text-secondary" role="status" aria-label="Analysiere" />
                  <span className="muted">Analysiere…</span>
                </div>
              )}
              {err && <div className="mt-2 text-danger"><i className="bi bi-exclamation-triangle me-2" />{err}</div>}
            </div>

            <div className="d-flex flex-wrap gap-3">
              {/* Compliance */}
              <div className="card p-3" style={{ minWidth: 200 }}>
                <div className="muted">
                    Compliance{" "}
                    <span className="ms-1" title={complianceTooltip} aria-label="Details">
                        <i className="bi bi-info-circle" />
                    </span>
                </div>
                <div className={`kpi ${compColor}`}>{compliance == null ? "—" : `${compliance}/100`}</div>
                <div className="small fw-semibold" style={{ color: "#aab0bb" }}>
                  {compliance == null ? "—" : (compliance >= 85 ? "Hervorragend" : compliance >= 70 ? "Solide" : compliance >= 50 ? "Kritisch" : "Schlecht")}
                </div>
                {compliance == null ? (
                  <div className="mt-1 small muted">No data</div>
                ) : (
                  <div className="progress" role="progressbar" aria-valuenow={compliance} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`progress-bar ${compliance >= 85 ? "bg-success" : compliance >= 70 ? "bg-warning" : "bg-danger"}`} style={{ width: `${compliance}%` }} />
                  </div>
                )}
              </div>

              {/* Risiko */}
              <div className="card p-3" style={{ minWidth: 200 }}>
                <div className="muted">
                    Risiko{" "}
                    <span className="ms-1" title={riskTooltip} aria-label="Details">
                        <i className="bi bi-info-circle" />
                    </span>
                </div>
                <div className={`kpi ${riskColor}`}>{risk == null ? "—" : `${risk}/100`}</div>
                <div className="small fw-semibold" style={{ color: "#aab0bb" }}>
                  {risk == null ? "—" : (risk <= 15 ? "Sehr gering" : risk <= 30 ? "Begrenzt" : risk <= 60 ? "Erhöht" : "Hoch")}
                </div>
                {risk == null ? (
                  <div className="mt-1 small muted">No data</div>
                ) : (
                  <div className="progress" role="progressbar" aria-valuenow={risk} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`progress-bar ${risk <= 20 ? "bg-success" : risk <= 40 ? "bg-warning" : "bg-danger"}`} style={{ width: `${risk}%` }} />
                  </div>
                )}
              </div>

              {/* Vertragsinformationen */}
              <div className="card p-3" style={{ minWidth: 260 }}>
                <div className="muted">Vertrags­informationen</div>
                <div className="fw-semibold">{data?.meta?.titel || "—"}</div>
                <div className="muted small">{data?.meta?.datum || "—"}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Chart + Summary */}
      <div className="row g-3 mb-4">
        <div className="col-lg-5">
          <div className="card h-100">
            <div className="card-body">
              <h2 className="h6 mb-3">Statusverteilung (Art. 28)</h2>
              {data && kpis.any ? <canvas ref={chartRef} height={220} /> : <div className="muted">Noch keine Daten</div>}
              <div className="mt-2 small muted">
                <span style={{ color: "#16a34a" }}>■</span> erfüllt&nbsp;&nbsp;
                <span style={{ color: "#f59e0b" }}>■</span> teilweise&nbsp;&nbsp;
                <span style={{ color: "#ef4444" }}>■</span> fehlt
              </div>
            </div>
          </div>
        </div>
        <div className="col-lg-7">
          <div className="card h-100">
            <div className="card-body">
              <h2 className="h6 mb-2">Executive Summary</h2>
              <p className="mb-0" style={{ color: "var(--text)" }}>{summaryText}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Vertragsinformationen + Parteien */}
      <div className="card mb-4">
        <div className="card-body">
          <h2 className="h6">Vertragsinformationen</h2>
          <div className="row">
            <div className="col-md-6 mb-3">
              <div><span className="muted">Titel:</span> {data?.meta?.titel || "—"}</div>
              <div><span className="muted">Datum:</span> {data?.meta?.datum || "—"}</div>
            </div>
            <div className="col-md-6">
              <div className="muted">Parteien</div>
              {!data || toArray(data.parties).length === 0 ? (
                <div className="muted">—</div>
              ) : (
                <ul className="mb-0">
                  {toArray<any>(data.parties).map((p, i) => (
                    <li key={i} className="text-white">
                      {p.rolle}: {p.name} {p.land ? `(${p.land})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Matrix */}
      <div className="card mb-4">
        <div className="card-body">
          <h2 className="h6 mb-3">Prüfmatrix (Art. 28 Abs. 3)</h2>
          {!data ? (
            <div className="muted">Noch keine Daten</div>
          ) : (
            <div className="table-responsive">
              <table className="table align-middle">
                <thead>
                  <tr>
                    <th style={{ width: "18rem" }}>Kategorie</th>
                    <th style={{ width: "8rem" }}>Status</th>
                    <th>Belege</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(ART28_LABELS).map(([canon, label]) => {
                    const f = (data?.a28 ?? ({} as any))[canon] as { status?: string; belege?: Evidence[] } | undefined;
                    const belege = toArray<Evidence>(f?.belege);
                    return (
                      <tr key={canon}>
                        <td className="fw-semibold">{label}</td>
                        <td>{badge(f?.status)}</td>
                        <td className="text-break">{renderEvidence(belege) || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Zusatzklauseln */}
      <div className="card mb-4">
        <div className="card-body">
          <h2 className="h6 mb-3">Zusatzklauseln</h2>
          {!data ? (
            <div className="muted">Noch keine Daten</div>
          ) : (
            <div className="table-responsive">
              <table className="table align-middle">
                <thead>
                  <tr>
                    <th style={{ width: "20rem" }}>Kategorie</th>
                    <th style={{ width: "8rem" }}>Status</th>
                    <th>Belege</th>
                  </tr>
                </thead>
                <tbody>
                  {["internationale_übermittlungen", "haftungsbegrenzung", "gerichtsstand_recht"].map((k) => {
                    const label =
                      k === "internationale_übermittlungen"
                        ? "Internationale Übermittlungen"
                        : k === "haftungsbegrenzung"
                        ? "Haftungsbegrenzung"
                        : "Gerichtsstand/Recht";
                    const f = (data?.extras as any)?.[k] ?? {};
                    const belege = toArray<Evidence>(f?.belege);
                    return (
                      <tr key={k}>
                        <td className="fw-semibold">{label}</td>
                        <td>{badge(f?.status)}</td>
                        <td className="text-break">{renderEvidence(belege) || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Empfohlene Maßnahmen */}
      <div className="card mb-4">
        <div className="card-body">
          <h2 className="h6 mb-3">Empfohlene Maßnahmen</h2>
          {!data ? (
            <div className="muted">Noch keine Daten</div>
          ) : toArray(data.actions).length === 0 ? (
            <div className="muted">—</div>
          ) : (
            <div className="list-group">
              {toArray<any>(data.actions).map((a, i) => {
                const sev = a.severity === "high" ? "danger" : a.severity === "medium" ? "warning" : "info";
                const heading = labelForCategory(a.category || a.issue || "");
                const detail = a.suggested_clause ?? a.action ?? "";
                return (
                  <div
                    key={i}
                    className="list-group-item d-flex justify-content-between align-items-start"
                    style={{ background: "#0f1422", borderColor: "#1d2540", color: "var(--text)" }}
                  >
                    <div className="ms-2 me-auto">
                      <div className="fw-semibold">{heading}</div>
                      {detail && <small className="muted d-block">{detail}</small>}
                    </div>
                    <span className={`badge text-bg-${sev} rounded-pill`}>{a.severity}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Raw JSON */}
      {raw && (
        <div className="mb-5">
          <div className="form-check">
            <input className="form-check-input" type="checkbox" id="raw" checked={showRaw} onChange={() => setShowRaw(!showRaw)} />
            <label className="form-check-label" htmlFor="raw">Raw JSON anzeigen</label>
          </div>
          {showRaw && (
            <pre className="mt-3 p-3 rounded" style={{ background: "#0b0e14", border: "1px solid #1d2540", color: "var(--text)", whiteSpace: "pre-wrap" }}>
              {JSON.stringify(raw, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}