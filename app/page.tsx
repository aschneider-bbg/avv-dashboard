"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * AVV Dashboard (beide Schemas werden unterstützt)
 * - Agent-Builder: { contract_metadata, findings{art_28, additional_clauses}, risk_score, actions }
 * - Altes Schema:  { vertrag_metadata, prüfung{art_28, zusatzklauseln}, risiko_score/risk_score, actions }
 * Wir normalisieren alles auf ein internes, deutsches Modell.
 */

type Evidence = { quote: string; page?: number };
type Clause = { status?: string; belege?: Evidence[]; evidence?: Evidence[] };

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

function mapStatus(v?: string) {
  if (!v) return undefined;
  const low = v.toLowerCase();
  return (
    STATUS_EN_TO_DE[low] ||
    (["erfüllt", "teilweise", "fehlt", "vorhanden", "nicht gefunden"] as const).find((x) => x === low) ||
    undefined
  );
}

/** Normalisiert beliebige API-Antwort in ein gemeinsames deutsches Objekt */
function normalize(input: any) {
  // Metadata
  const meta =
    input?.vertrag_metadata ??
    (input?.contract_metadata
      ? {
          titel: input.contract_metadata.title ?? "",
          datum: input.contract_metadata.date ?? "",
          parteien: (input.contract_metadata.parties ?? []).map((p: any) => ({
            rolle:
              p.role === "controller"
                ? "Verantwortlicher"
                : p.role === "processor"
                ? "Auftragsverarbeiter"
                : p.role ?? "",
            name: p.name ?? "",
            land: p.country ?? "",
          })),
        }
      : {});

  // Art. 28
  const a28src = input?.prüfung?.art_28 ?? input?.findings?.art_28 ?? {};
  const a28: Record<string, { status?: string; belege: Evidence[] }> = {};
  // Deutsch direkt übernehmen
  for (const k of Object.keys(ART28_LABELS)) {
    const node = a28src[k];
    if (node) {
      a28[k] = {
        status: mapStatus(node.status) ?? node.status,
        belege: (node.belege ?? node.evidence ?? []) as Evidence[],
      };
    }
  }
  // Englisch -> Kanon
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
  const extrasSrc = input?.prüfung?.zusatzklauseln ?? input?.findings?.additional_clauses ?? {};
  const extras = {
    internationale_übermittlungen: extrasSrc?.internationale_übermittlungen ?? extrasSrc?.international_transfers,
    haftungsbegrenzung: extrasSrc?.haftungsbegrenzung ?? extrasSrc?.liability_cap,
    gerichtsstand_recht: extrasSrc?.gerichtsstand_recht ?? extrasSrc?.jurisdiction,
  };
  const extrasNorm: Record<string, { status?: string; belege: Evidence[] }> = {};
  for (const [k, v] of Object.entries(extras)) {
    if (!v) continue;
    extrasNorm[k] = {
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

  const actions: any[] = input?.actions ?? [];

  return {
    meta,
    a28,
    extras: extrasNorm,
    riskOverall,
    riskRationale,
    actions,
  };
}

export default function Page() {
  const [raw, setRaw] = useState<any>(null);
  const [data, setData] = useState<ReturnType<typeof normalize> | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const chartRef = useRef<HTMLCanvasElement | null>(null);
  const chartInst = useRef<any>(null);

  // ---- KPIs (aus normalisiertem Modell) ----
  const kpis = useMemo(() => {
    const src = data?.a28 ?? {};
    const statuses = Object.values(src).map((x) => x?.status || "");
    const erfüllt = statuses.filter((s) => s === "erfüllt").length;
    const teilweise = statuses.filter((s) => s === "teilweise").length;
    const fehlt = statuses.filter((s) => s === "fehlt").length;
    const total = Object.keys(ART28_LABELS).length;
    return { erfüllt, teilweise, fehlt, total, any: erfüllt + teilweise + fehlt > 0 };
  }, [data]);

  // ---- Compliance & Risiko ----

  // 1) Compliance aus Matrix berechnen (erfüllt=1, teilweise=0.5, fehlt=0) + leichte Gewichtung der Zusatzklauseln
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

  // 2) Agent-Output: Manche Agent-Konfigurationen liefern risk_score.overall als POSITIVEN Score (Compliance)
  const agentOverall: number | null =
    typeof raw?.risk_score?.overall === "number" ? raw.risk_score.overall : null;

  const rationaleText = (raw?.risk_score?.rationale || data?.riskRationale || "").toString().toLowerCase();

  // Positiv-Tokens: wenn im Rationale-Text vorhanden, interpretieren wir agentOverall als Compliance
  const POSITIVE_TOKENS = [
    "deckt die wesentlichen anforderungen",
    "wesentlichen anforderungen",
    "anforderungen abgedeckt",
    "weitgehend erfüllt",
    "erfüllt",
    "konform",
    "entspricht art. 28",
  ];
  const mentionsPositive = POSITIVE_TOKENS.some((t) => rationaleText.includes(t));
  const isLikelyComplianceScore = agentOverall != null && (agentOverall >= 60 || mentionsPositive) && mentionsPositive;

  // 3) Finale Compliance: Agent (wenn positiv erkannt) > Matrix-Fallback
  const compliance = isLikelyComplianceScore ? agentOverall : complianceMatrix;

  // 4) Risiko: Falls Agentwert negativ zu interpretieren ist, nutze ihn; sonst 100 - Compliance
  const serverRiskClassic: number | null =
    typeof data?.riskOverall === "number" ? data.riskOverall : null;

  const risk = !isLikelyComplianceScore && agentOverall != null
    ? agentOverall
    : (serverRiskClassic != null
        ? serverRiskClassic
        : (compliance != null ? Math.max(0, 100 - compliance) : null));

  // Ampellogik
  const compColor =
    compliance == null ? "text-secondary" : compliance >= 85 ? "text-success" : compliance >= 70 ? "text-warning" : "text-danger";
  const riskColor =
    risk == null ? "text-secondary" : risk <= 20 ? "text-success" : risk <= 40 ? "text-warning" : "text-danger";

  const compLabel =
    compliance == null ? "—" : compliance >= 85 ? "Hervorragend" : compliance >= 70 ? "Solide" : compliance >= 50 ? "Kritisch" : "Schlecht";
  const riskLabel =
    risk == null ? "—" : risk <= 15 ? "Sehr gering" : risk <= 30 ? "Begrenzt" : risk <= 60 ? "Erhöht" : "Hoch";

  // Doughnut-Chart
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

  // Upload
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    setLoading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      // WICHTIG: Agent-Route verwenden
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

  const rationale = data?.riskRationale || "—";

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
                <div className="muted">Compliance</div>
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

              {/* Rote Warnzeile bei schlechtem Ergebnis */}
              {(compliance != null && compliance < 60) || (risk != null && risk > 60) ? (
                <div className="w-100 mt-3 text-danger d-flex align-items-center" style={{ gap: 8 }}>
                  <i className="bi bi-exclamation-triangle-fill"></i>
                  <span className="small">Niedrige Vertragstreue / erhöhtes Risiko – Vertrag sollte dringend nachgeschärft werden.</span>
                </div>
              ) : null}

              {/* Vertragsinformationen */}
              <div className="card p-3" style={{ minWidth: 240 }}>
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
              <p className="mb-0" style={{ color: "var(--text)" }}>{data?.riskRationale || "—"}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Vertragsinformationen */}
      <div className="card mb-4">
        <div className="card-body">
          <h2 className="h6">Vertragsinformationen</h2>
          <div className="row">
            <div className="col-md-6">
              <div><span className="muted">Titel:</span> {data?.meta?.titel || "—"}</div>
              <div><span className="muted">Datum:</span> {data?.meta?.datum || "—"}</div>
            </div>
            <div className="col-md-6">
              <div className="muted">Parteien</div>
              {!data ? (
                <div className="muted">—</div>
              ) : (
                <ul className="mb-0">
                  {(raw?.vertrag_metadata?.parteien ??
                    raw?.contract_metadata?.parties?.map((p: any) => ({
                      rolle:
                        p.role === "controller"
                          ? "Verantwortlicher"
                          : p.role === "processor"
                          ? "Auftragsverarbeiter"
                          : p.role ?? "",
                      name: p.name,
                      land: p.country,
                    })) ??
                    []
                  ).map((p: any, i: number) => (
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
                    const f = data?.extras?.[k] ?? {};
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

      {/* Maßnahmen */}
      <div className="card mb-4">
        <div className="card-body">
          <h2 className="h6 mb-3">Empfohlene Maßnahmen</h2>
          {!data ? (
            <div className="muted">Noch keine Daten</div>
          ) : (raw?.actions || []).length === 0 ? (
            <div className="muted">—</div>
          ) : (
            <div className="list-group">
              {(raw?.actions || []).map((a: any, i: number) => {
                const sev = a.severity === "high" ? "danger" : a.severity === "medium" ? "warning" : "info";
                return (
                  <div
                    key={i}
                    className="list-group-item d-flex justify-content-between align-items-start"
                    style={{ background: "#0f1422", borderColor: "#1d2540", color: "var(--text)" }}
                  >
                    <div className="ms-2 me-auto">
                      <div className="fw-semibold">{a.issue}</div>
                      <small className="muted">{a.suggested_clause}</small>
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