// app/layout.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AVV-Check Dashboard",
  description: "Automated AVV review with GDPR Art. 28 matrix",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <head>
        {/* Bootstrap CSS */}
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
          rel="stylesheet"
        />
        {/* Bootstrap Icons */}
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css"
          rel="stylesheet"
        />
        {/* Chart.js */}
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" />
        <style>{`
          /* ---- Dark Theme (kontraststark) ---- */
          :root {
            --bg: #0b0e14;         /* Seitenhintergrund */
            --panel: #121826;      /* Karten */
            --panel-border: #1d2540;
            --text: #f1f4fa;       /* Primärtext (hell) */
            --text-soft: #c8cfdd;  /* Sekundärtext */
            --muted: #aab3c4;      /* Subtle */
          }
          html, body { height:100% }
          body { background: var(--bg); color: var(--text); }

          .card {
            background: var(--panel);
            border: 1px solid var(--panel-border);
            color: var(--text);           /* <-- Karten-Inhalt hell */
          }
          .card .muted { color: var(--text-soft); }

          .table thead th { color: var(--text-soft); font-weight:600; }
          .table td { color: var(--text); }

          .badge-met { background:#16a34a; }
          .badge-partial { background:#f59e0b; }
          .badge-missing { background:#ef4444; }
          .badge-notfound { background:#64748b; }

          .muted { color: var(--muted); }

          .chip {
            background:#151b2b;
            border:1px solid #222a44;
            border-radius:999px;
            padding:.35rem .75rem;
            color: var(--text);
          }

          .upload { border:1px dashed #2a3147; border-radius:.75rem; padding:1rem; }
          .kpi { font-size:2.125rem; font-weight:700; }

          /* Links/Inputs in Dark */
          .form-control, .form-select {
            background:#0f1422; color:var(--text);
            border:1px solid #2a3147;
          }
          .form-control:focus { background:#0f1422; color:var(--text); border-color:#3a4a80; box-shadow:none; }

          /* Chart Legend Text */
          .chartjs-render-monitor, canvas { background:transparent; }

          /* Dark-Overrides für Tabellen & Listen (kein Weiß mehr) */
            .table {
            --bs-table-bg: transparent;
            --bs-table-color: var(--text);
            --bs-table-striped-bg: #0f1422;
            --bs-table-striped-color: var(--text);
            --bs-table-hover-bg: #121a2a;
            --bs-table-hover-color: var(--text);
            color: var(--text);
            background: transparent;
            }
            .table td, .table th { background-color: transparent !important; color: var(--text); }

            /* List Groups */
            .list-group-item {
            background: #0f1422 !important;
            color: var(--text) !important;
            border-color: #1d2540 !important;
            }

            /* Badges klar auf dunklem Grund */
            .badge { color: #fff; }
                    `}</style>
      </head>
      <body>
        {children}
        {/* Bootstrap JS */}
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" />
      </body>
    </html>
  );
}
