"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/** ========= Typen ========= */
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
  // Kern-Artikel
  instructions_only: "Weisung (nur auf dokumentierte Weisung)",
  confidentiality: "Vertraulichkeit",
  security_TOMs: "Technisch-organisatorische Maßnahmen",
  subprocessors: "Unterauftragsverarbeiter",
  data_subject_rights_support: "Unterstützung Betroffenenrechte",
  breach_support: "Unterstützung bei Datenschutzverletzungen",
  deletion_return: "Löschung/Rückgabe nach Vertragsende",
  audit_rights: "Audit- und Nachweisrechte",
  // Zusatzklauseln
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

/** ========= Normalisierung ========= */
function normalize(input: any) {
  // Executive Summary
  const executiveSummary: string = input?.executive_summary ?? "";

  // Metadata (Titel/Datum)
  const meta =
    input?.vertrag_metadata ??
    (input?.contract_metadata
      ? {
          titel: input.contract_metadata.title ?? "",
          datum: input.contract_metadata.date ?? "",
        }
      : { titel: "", datum: "" });

  // Parteien – Variante A: contract_metadata.parties (Array)
  const partiesA =
    input?.contract_metadata?.parties?.map((p: any) => ({
      rolle:
        p?.role === "controller"
          ? "Verantwortlicher"
          : p?.role === "processor"
          ? "Auftragsverarbeiter"
          : p?.role || "",
      name: p?.name || "",
      land: p?.country || "",
    })) ?? [];

  // Parteien – Variante B: parties (Objekt mit controller/processor/processor_dpo)
  const partiesB: { rolle: string; name: string; land?: string }[] = [];
  if (input?.parties && typeof input.parties === "object") {
    const p = input.parties;
    if (p.controller)
      partiesB.push({ rolle: "Verantwortlicher", name: String(p.controller) });
    if (p.processor)
      partiesB.push({ rolle: "Auftragsverarbeiter", name: String(p.processor) });
    if (p.processor_dpo)
      partiesB.push({ rolle: "Datenschutzbeauftragter (AV)", name: String(p.processor_dpo) });
  }

  const parties = [...partiesA, ...partiesB];

  // Art. 28
  const a28src = input?.prüfung?.art_28 ?? input?.findings?.art_28 ?? input?.article_28_analysis ?? {};
  const a28: Record<string, { status?: string; belege: Evidence[] }> = {};
  // Deutsch-Kanon zuerst
  for (const k of Object.keys(ART28_LABELS)) {
    const node = a28src[k];
    if (node) {
      a28[k] = {
        status: mapStatus(node.status) ?? node.status,
        belege: (node.belege ?? node.evidence ?? []) as Evidence[],
      };
    }
  }
  // Englisch → Kanon
  for (const k of Object.keys(a28src)) {
    const canon = EN_TO_CANON[k];
    if (canon && !a28[canon]) {
      const node = a28src[k];
      a28[canon] = {
        status: mapStatus(node?.status) ?? node?.status,
        belege: (node?.evidence ?? node?.belege ?? []) as Evidence[],
      };
    }
  }

  // Zusatzklauseln
  const extrasSrc =
    input?.prüfung?.zusatzklauseln ?? input?.findings?.additional_clauses ?? input?.additional_clauses ?? {};
  const extrasMap = {
    internationale_übermittlungen: extrasSrc?.internationale_übermittlungen ?? extrasSrc?.international_transfers,
    haftungsbegrenzung: extrasSrc?.haftungsbegrenzung ?? extrasSrc?.liability_cap,
    gerichtsstand_recht: extrasSrc?.gerichtsstand_recht ?? extrasSrc?.jurisdiction,
  };
  const extras: Record<string, { status?: string; belege: Evidence[] }> = {};
  for (const [k, v] of Object.entries(extrasMap)) {
    if (!v) continue;
    extras[k] = {
      status: mapStatus((v as any).status) ?? (v as any).status,
      belege: ((v as any).belege ?? (v as any).evidence ?? []) as Evidence[],
    };
  }

  // Scores & rationale
  const riskOverall =
    typeof input?.risiko_score?.gesamt === "number"
      ? input.risiko_score.gesamt
      : typeof input?.risk_score?.overall === "number"
      ? input.risk_score.overall
      : null;
  const riskRationale = input?.risk_rationale ?? input?.risk_score?.rationale ?? "";

  const actions: any[] =
    input?.recommended_actions ??
    input?.actions ??
    [];

  return {
    executiveSummary,
    meta,
    parties,
    a28,
    extras,
    riskOverall,
    riskRationale,
    actions,
    raw: input,
  };
}

/** ========= Mini-Tooltip (ohne Lib) ========= */
function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="bbg-tooltip">
      {children}
      <span className="bbg-tooltip-content">{text}</span>
      <style jsx>{`
        .bbg-tooltip {
          position: relative;
          display: inline-flex;
          align-items: center;
        }
        .bbg-tooltip-content {
          position: absolute;
          left: 50%;
          bottom: 135%;
          transform: translateX(-50%);
          min-width: 260px;
          max-width: 420px;
          padding: 10px 12px;
          border-radius: 8px;
          background: #0b0e14;
          color: #e8eefc;
          border: 1px solid #1d2540;
          box-shadow: 0 8px 24px rgba(0,0,0,.35);
          font-size: 12.5px;
          line-height: 1.35;
          white-space: pre-wrap;
          opacity: 0;
          pointer-events: none;
          transition: opacity .15s ease, transform .15s ease;
          z-index: 50;
        }
        .bbg-tooltip:hover .bbg-tooltip-content,
        .bbg-tooltip:focus-within .bbg-tooltip-content {
          opacity: 1;
          transform: translateX(-50%) translateY(-2px);
        }
      `}</style>
    </span>
  );
}

/** EN->DE für Scoring-Keys */
const SCORE_KEY_LABELS: Record<string, string> = {
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
};

function labelScoreKey(k: string) {
  return SCORE_KEY_LABELS[k] ?? k.replace(/_/g, " ");
}

/** Tooltip-Text aus compliance_score bauen */
function buildComplianceTooltip(raw: any, fallbackCompliance: number | null) {
  const cs = raw?.compliance_score ?? {};
  const details: Record<string, number> =
    typeof cs.details === "object" && cs.details !== null ? cs.details : {};
  const bonus =
    typeof cs.bonus === "number"
      ? cs.bonus
      : typeof cs.bonuses === "number"
      ? cs.bonuses
      : null;
  const penalties =
    typeof cs.penalties === "number"
      ? cs.penalties
      : typeof cs.deductions === "number"
      ? cs.deductions
      : null;
  const rationale =
    typeof cs.rationale === "string" && cs.rationale.trim().length > 0
      ? cs.rationale.trim()
      : "";

  // Tooltip-Inhalt zusammenbauen
  let text = "Begründung Compliance\n";
  text += rationale ? `${rationale}\n\n` : "—\n\n";
  text += "Detailpunkte\n";

  // sichere Iteration, ohne .map()
  const keys = Object.keys(details);
  if (keys.length > 0) {
    for (const key of keys) {
      const val = details[key];
      const label =
        SCORE_KEY_LABELS[key] ??
        key.replace(/_/g, " ").replace(/\b\w/g, (s) => s.toUpperCase());
      text += `• ${label}: ${val}\n`;
    }
  } else if (fallbackCompliance != null) {
    text += `• (berechneter Score): ${fallbackCompliance}\n`;
  } else {
    text += "• —\n";
  }

  if (bonus != null) text += `• Bonus: +${bonus}\n`;
  if (penalties != null) text += `• Abzüge: −${penalties}\n`;

  return text.trim();
}

/** ========= Komponente ========= */
export default function Page() {
  const [raw, setRaw] = useState<any>(null);
  const [data, setData] = useState<ReturnType<typeof normalize> | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const chartRef = useRef<HTMLCanvasElement | null>(null);
  const chartInst = useRef<any>(null);

  // KPIs aus Matrix
  const kpis = useMemo(() => {
    const src = data?.a28 ?? {};
    const statuses = Object.values(src).map((x) => x?.status || "");
    const erfüllt = statuses.filter((s) => s === "erfüllt").length;
    const teilweise = statuses.filter((s) => s === "teilweise").length;
    const fehlt = statuses.filter((s) => s === "fehlt").length;
    const total = Object.keys(ART28_LABELS).length;
    return { erfüllt, teilweise, fehlt, total, any: erfüllt + teilweise + fehlt > 0 };
  }, [data]);

  // Compliance aus Matrix (+leichter Bonus für Zusatzklauseln)
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

  // Falls ein „overall“ vom Backend eigentlich Compliance ist, erkennen:
  const agentOverall: number | null =
    typeof raw?.risk_score?.overall === "number" ? raw.risk_score.overall : null;

  const rationaleText = (data?.riskRationale || "").toString().toLowerCase();
  const POSITIVE_TOKENS = ["wesentlichen anforderungen", "weitgehend erfüllt", "konform", "erfüllt", "entspricht art. 28"];
  const mentionsPositive = POSITIVE_TOKENS.some((t) => rationaleText.includes(t));
  const isLikelyComplianceScore = agentOverall != null && agentOverall >= 60 && mentionsPositive;

  const compliance = isLikelyComplianceScore ? agentOverall : complianceMatrix;
  const risk = isLikelyComplianceScore
    ? (compliance != null ? Math.max(0, 100 - compliance) : null)
    : (typeof data?.riskOverall === "number"
        ? data.riskOverall
        : (agentOverall != null ? agentOverall : (compliance != null ? Math.max(0, 100 - compliance) : null)));

  const compColor =
    compliance == null ? "text-secondary" : compliance >= 85 ? "text-success" : compliance >= 70 ? "text-warning" : "text-danger";
  const riskColor =
    risk == null ? "text-secondary" : risk <= 20 ? "text-success" : risk <= 40 ? "text-warning" : "text-danger";

  const compLabel =
    compliance == null ? "—" : compliance >= 85 ? "Hervorragend" : compliance >= 70 ? "Solide" : compliance >= 50 ? "Kritisch" : "Schlecht";
  const riskLabel =
    risk == null ? "—" : risk <= 15 ? "Sehr gering" : risk <= 30 ? "Begrenzt" : risk <= 60 ? "Erhöht" : "Hoch";

  // Doughnut
  const donut = useMemo(() => [kpis.erfüllt, kpis.teilweise, kpis.fehlt], [kpis]);
  useEffect(() => {
    const Chart = (window as any).Chart as any;
    if (!Chart || !chartRef.current) return;

    if (!data || !kpis.any) {
      if (chartInst.current) {
        chartInst.current.destroy();
        chartInst.current = null;
      }
      return;
    }
    if (chartInst.current) chartInst.current.destroy();
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

  // Upload Handler
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    setLoading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/agent-avv", { method: "POST", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "API error");
      setRaw(json);
      setData(normalize(json));
    } catch (e: any) {
      setErr(e.message);
      setRaw(null);
      setData(null);
    } finally {
      setLoading(false);
      e.target.value = "";
      setInputKey((k) => k + 1);
    }
  };

  const renderEvidence = (ev?: Evidence[]) =>
    (ev || []).map((e) => `S.${e.page ?? "?"}: „${(e.quote || "").slice(0, 140)}…“`).join(" • ");

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
               <div className="muted d-flex align-items-center gap-1">
                <span>Compliance</span>
                {(raw?.compliance_score || compliance != null) && (
                    <Tooltip text={buildComplianceTooltip(raw, compliance)}>
                    <i
                        className="bi bi-info-circle ms-1"
                        style={{ fontSize: 14, color: "#9db2d6", cursor: "help" }}
                        aria-label="Scoring-Details"
                        tabIndex={0}
                    />
                    </Tooltip>
                )}
                </div>
                <div className={`kpi ${compColor}`}>{compliance == null ? "—" : `${compliance}/100`}</div>
                <div className="small fw-semibold" style={{ color: "#aab0bb" }}>{compLabel}</div>
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
                <div className="muted">Risiko</div>
                <div className={`kpi ${riskColor}`}>{risk == null ? "—" : `${risk}/100`}</div>
                <div className="small fw-semibold" style={{ color: "#aab0bb" }}>{riskLabel}</div>
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
              {!data || (data.parties ?? []).length === 0 ? (
                <div className="muted">—</div>
              ) : (
                <ul className="mb-0">
                  {data.parties.map((p: any, i: number) => (
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
                    const f = data?.a28?.[canon] as { status?: string; belege?: Evidence[] } | undefined;
                    const belege = f?.belege ?? [];
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
                    const belege = (f as any).belege ?? [];
                    return (
                      <tr key={k}>
                        <td className="fw-semibold">{label}</td>
                        <td>{badge((f as any).status)}</td>
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
          ) : (data?.actions || []).length === 0 ? (
            <div className="muted">—</div>
          ) : (
            <div className="list-group">
              {(data?.actions || []).map((a: any, i: number) => {
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