"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Frontend Dashboard (Dark UI)
 * - Zeigt Compliance-Score (0–100, höher ist besser)
 * - Leitet Risiko = 100 - Compliance ab, wenn kein Server-Risiko vorhanden ist
 * - Deutsche Labels (erfüllt/teilweise/fehlt)
 * - Robuste Anzeige gegen verschiedene API-Formate
 */

type Evidence = { quote: string; page: number };
type Clause = { status?: string; belege?: Evidence[]; evidence?: Evidence[] };

const ART28_KEYS: Record<string, string> = {
  instructions_only: "Weisung",
  confidentiality: "Vertraulichkeit",
  security_TOMs: "TOMs",
  subprocessors: "Subprozessoren",
  data_subject_rights_support: "Betroffenenrechte",
  breach_support: "Breach-Unterstützung",
  deletion_return: "Löschung/Rückgabe",
  audit_rights: "Audit/Nachweis",
};

// Kanonische Schlüssel (EN -> DE) für Zugriff auf data.prüfung.art_28
const CANON_MAP: Record<string, string> = {
  instructions_only: "weisung",
  confidentiality: "vertraulichkeit",
  security_TOMs: "toms",
  subprocessors: "unterauftragsverarbeiter",
  data_subject_rights_support: "betroffenenrechte",
  breach_support: "vorfallmeldung",
  deletion_return: "löschung_rückgabe",
  audit_rights: "audit_nachweis",
};

export default function Page() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const chartRef = useRef<HTMLCanvasElement | null>(null);
  const chartInst = useRef<any>(null);

  // ---- KPIs aus den Labels (deutsch) ----
  const kpis = useMemo(() => {
    const a28 = data?.prüfung?.art_28 || {};
    const statuses = Object.values(a28).map((x: any) => x?.status || "");
    const erfüllt = statuses.filter((s) => s === "erfüllt").length;
    const teilweise = statuses.filter((s) => s === "teilweise").length;
    const fehlt = statuses.filter((s) => s === "fehlt").length;
    const total = Object.keys(ART28_KEYS).length;
    return { erfüllt, teilweise, fehlt, total, any: erfüllt + teilweise + fehlt > 0 };
  }, [data]);

  // ---- Compliance & Risiko ----
  const complianceFromServer: number | null =
    (typeof data?.compliance_score?.overall === "number" && data?.compliance_score?.overall >= 0)
      ? data.compliance_score.overall
      : null;

  const complianceFallback: number | null = useMemo(() => {
    if (!kpis.any) return null;
    // Spiegel-Logik zur Serverberechnung: erfüllt=1, teilweise=0.5, fehlt=0
    const achieved = kpis.erfüllt * 1 + kpis.teilweise * 0.5;
    let score = (achieved / Object.keys(ART28_KEYS).length) * 100;

    // Zusatzklauseln grob berücksichtigen, wenn vorhanden
    const extras = data?.prüfung?.zusatzklauseln || {};
    const intl = extras?.["internationale_übermittlungen"]?.status;
    if (intl === "erfüllt") score += 10;
    else if (intl === "teilweise") score += 5;
    else if (intl === "vorhanden") score += 3;

    const liab = extras?.["haftungsbegrenzung"]?.status;
    if (liab === "erfüllt" || liab === "vorhanden") score += 3;

    const juris = extras?.["gerichtsstand_recht"]?.status;
    if (juris === "erfüllt" || juris === "vorhanden") score += 2;

    return Math.max(0, Math.min(100, Math.round(score)));
  }, [kpis, data?.prüfung?.zusatzklauseln]);

  const compliance = complianceFromServer ?? complianceFallback;

  const riskFromServer: number | null =
    typeof data?.risiko_score?.gesamt === "number" ? data.risiko_score.gesamt
    : typeof data?.risk_score?.overall === "number" && data?.risk_score?.type === "risk" ? data.risk_score.overall
    : null;

  const risk = riskFromServer ?? (compliance != null ? Math.max(0, 100 - compliance) : null);

  // Neue, strengere Schwellen für klare Ampellogik
  const compColor =
    compliance == null
      ? "text-secondary"
      : compliance >= 85
      ? "text-success"
      : compliance >= 70
      ? "text-warning"
      : "text-danger";

  // Risiko: strenger, damit mittelmäßige Scores sichtbar kritisch wirken
  const riskColor =
    risk == null
      ? "text-secondary"
      : risk <= 20
      ? "text-success"
      : risk <= 40
      ? "text-warning"
      : "text-danger";

  // Text-Labels unterhalb der KPIs
  const compLabel =
    compliance == null
      ? "—"
      : compliance >= 85
      ? "Hervorragend"
      : compliance >= 70
      ? "Solide"
      : compliance >= 50
      ? "Kritisch"
      : "Schlecht";

  const riskLabel =
    risk == null
      ? "—"
      : risk <= 15
      ? "Sehr gering"
      : risk <= 30
      ? "Begrenzt"
      : risk <= 60
      ? "Erhöht"
      : "Hoch";

  // ---- Doughnut-Chart ----
  const donut = useMemo(() => [kpis.erfüllt, kpis.teilweise, kpis.fehlt], [kpis]);
  useEffect(() => {
    const Chart = (window as any).Chart as any;
    if (!Chart || !chartRef.current) return;

    if (!data || !kpis.any) {
      if (chartInst.current) { chartInst.current.destroy(); chartInst.current = null; }
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

  // ---- Upload ----
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    setLoading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/avv-check", { method: "POST", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "API error");
      setData(json);
    } catch (e: any) {
      setErr(e.message);
      setData(null);
    } finally {
      setLoading(false);
      e.target.value = "";
      setInputKey((k) => k + 1);
    }
  };

  const renderEvidence = (ev?: Evidence[]) =>
    (ev || []).map((e) => `S.${e.page}: „${(e.quote || "").slice(0, 140)}…“`).join(" • ");

  const badge = (s: string) => {
    if (s === "erfüllt") return <span className="badge" style={{ background: "#14532d" }}>erfüllt</span>;
    if (s === "teilweise") return <span className="badge" style={{ background: "#7c2d12" }}>teilweise</span>;
    if (s === "fehlt") return <span className="badge" style={{ background: "#7f1d1d" }}>fehlt</span>;
    if (s === "vorhanden") return <span className="badge bg-primary">vorhanden</span>;
    if (s === "nicht gefunden") return <span className="badge bg-secondary">nicht gefunden</span>;
    return <span className="badge bg-secondary">—</span>;
  };

  const rationale = data?.risk_rationale || data?.risk_score?.rationale || "—";

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
                    <div
                      className={`progress-bar ${compliance >= 85 ? "bg-success" : compliance >= 70 ? "bg-warning" : "bg-danger"}`}
                      style={{ width: `${compliance}%` }}
                    />
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
                    <div
                      className={`progress-bar ${risk <= 20 ? "bg-success" : risk <= 40 ? "bg-warning" : "bg-danger"}`}
                      style={{ width: `${risk}%` }}
                    />
                  </div>
                )}
              </div>
          {/* Rote Warnzeile bei schlechtem Ergebnis */}
          {(compliance != null && compliance &lt; 60) || (risk != null && risk &gt; 60) ? (
            <div className="w-100 mt-3 text-danger d-flex align-items-center" style={{ gap: 8 }}>
              <i className="bi bi-exclamation-triangle-fill"></i>
              <span className="small">Niedrige Vertragstreue / erhöhtes Risiko – Vertrag sollte dringend nachgeschärft werden.</span>
            </div>
          ) : null}

              {/* Vertragsinformationen */}
              <div className="card p-3" style={{ minWidth: 240 }}>
                <div className="muted">Vertrags­informationen</div>
                <div className="fw-semibold">{data?.vertrag_metadata?.titel || "—"}</div>
                <div className="muted small">{data?.vertrag_metadata?.datum || "—"}</div>
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
              <p className="mb-0" style={{ color: "var(--text)" }}>{rationale}</p>
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
              <div><span className="muted">Titel:</span> {data?.vertrag_metadata?.titel || "—"}</div>
              <div><span className="muted">Datum:</span> {data?.vertrag_metadata?.datum || "—"}</div>
            </div>
            <div className="col-md-6">
              <div className="muted">Parteien</div>
              {!data ? (
                <div className="muted">—</div>
              ) : (
                <ul className="mb-0">
                  {(data?.vertrag_metadata?.parteien || []).map((p: any, i: number) => (
                    <li key={i} className="text-white">{p.rolle}: {p.name} {p.land ? `(${p.land})` : ""}</li>
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
                  {Object.entries(ART28_KEYS).map(([k, label]) => {
                    const canon = CANON_MAP[k] ?? k;
                    const f: Clause | undefined = data?.prüfung?.art_28?.[canon] ?? data?.findings?.art_28?.[k];
                    const belege = f?.belege ?? f?.evidence ?? [];
                    return (
                      <tr key={k}>
                        <td className="fw-semibold">{label}</td>
                        <td>{badge(f?.status || "—")}</td>
                        <td className="text-break">{renderEvidence(belege as any) || "—"}</td>
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
                    const f = data?.prüfung?.zusatzklauseln?.[k] ?? {};
                    const belege = (f as any)?.belege ?? (f as any)?.evidence ?? [];
                    return (
                      <tr key={k}>
                        <td className="fw-semibold">{label}</td>
                        <td>{badge((f as any)?.status || "—")}</td>
                        <td className="text-break">{renderEvidence(belege as any) || "—"}</td>
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
          ) : (data?.actions || []).length === 0 ? (
            <div className="muted">—</div>
          ) : (
            <div className="list-group">
              {(data?.actions || []).map((a: any, i: number) => {
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
      {data && (
        <div className="mb-5">
          <div className="form-check">
            <input className="form-check-input" type="checkbox" id="raw" checked={showRaw} onChange={() => setShowRaw(!showRaw)} />
            <label className="form-check-label" htmlFor="raw">Raw JSON anzeigen</label>
          </div>
          {showRaw && (
            <pre
              className="mt-3 p-3 rounded"
              style={{ background: "#0b0e14", border: "1px solid #1d2540", color: "var(--text)", whiteSpace: "pre-wrap" }}
            >
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}