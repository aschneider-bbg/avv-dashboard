import { NextRequest, NextResponse } from "next/server";
import pdf from "pdf-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* --- PDF → Text --- */
async function pdfToText(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  const data = await pdf(buf).catch(() => null);
  if (!data || !data.text?.trim()) throw new Error("PDF konnte nicht gelesen werden.");
  return data.text
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* --- Workflow starten (Agent Builder) --- */
async function startWorkflow(input_as_text: string) {
  const res = await fetch("https://api.openai.com/v1/workflows/runs", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workflow_id: "wf_69010691804c8190a4d2dbf8d912f9df0957f13e0b29397a",
      inputs: { input_as_text },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Workflow creation failed: ${res.status} ${err}`);
  }
  return await res.json(); // enthält .id
}

/* --- Workflow-Status abrufen --- */
async function retrieveWorkflowRun(runId: string) {
  const res = await fetch(`https://api.openai.com/v1/workflows/runs/${runId}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Workflow retrieve failed: ${res.status} ${err}`);
  }
  return await res.json();
}

/* --- Polling bis abgeschlossen --- */
async function waitForWorkflowResult(runId: string, timeoutMs = 180_000) {
  const start = Date.now();
  let delay = 2000;

  while (true) {
    const current = await retrieveWorkflowRun(runId);
    const status = current.status;

    if (status === "completed" || status === "succeeded") {
      return current;
    }
    if (["failed", "cancelled"].includes(status)) {
      throw new Error(`Workflow ${status}: ${current.last_error?.message || "Unbekannter Fehler"}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("Workflow polling timeout (3 min überschritten)");
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1000, 5000);
  }
}

/* --- JSON aus Workflow-Resultat extrahieren --- */
function extractWorkflowJsonOutput(runObj: any) {
  const out = runObj?.outputs?.[0];
  if (out?.value) return out.value;

  const text = out?.content?.[0]?.text ?? out?.text ?? "";
  if (typeof text === "string" && text.trim()) {
    try {
      return JSON.parse(text);
    } catch {
      return { raw_output: text };
    }
  }
  return runObj?.outputs ?? null;
}

/* --- Haupt-POST-Handler --- */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData().catch(() => null);
    let textContent = "";

    if (form) {
      const file = form.get("file") as File | null;
      const text = (form.get("text") as string | null)?.trim();

      if (file && file.type?.includes("pdf")) {
        textContent = await pdfToText(file);
      } else if (text) {
        textContent = text;
      }
    } else {
      const json = await req.json().catch(() => null);
      textContent = json?.text?.trim() ?? "";
    }

    if (!textContent) {
      return NextResponse.json({ error: "Kein Text erkannt." }, { status: 400 });
    }

    // === Workflow starten und auf Ergebnis warten ===
    const run = await startWorkflow(textContent);
    const finished = await waitForWorkflowResult(run.id);
    const resultJson = extractWorkflowJsonOutput(finished);

    if (!resultJson) {
      throw new Error("Workflow lieferte keine verwertbare Ausgabe.");
    }

    return NextResponse.json(resultJson, { status: 200 });
  } catch (err: any) {
    console.error("❌ Fehler im AVV-Agent:", err);
    return NextResponse.json(
      { error: "Fehler beim AVV-Check", details: err.message ?? String(err) },
      { status: 500 }
    );
  }
}