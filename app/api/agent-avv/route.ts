import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import pdf from "pdf-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

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

/* --- POST: AVV-Prüfung --- */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData().catch(() => null);
    let textContent = "";

    // Eingabedaten extrahieren
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

    // 🔥 Workflow-Trigger im Agent Builder
    const run = await client.beta.workflows.runs.create({
        workflow_id: "wf_69010691804c8190a4d2dbf8d912f9df0957f13e0b29397a",
        inputs: { input_as_text: textContent },
    });

    // Warten bis Workflow fertig ist
    let completed;
    const maxTries = 20;
    for (let i = 0; i < maxTries; i++) {
      await new Promise((r) => setTimeout(r, 3000)); // 3 Sek. Polling
      const current = await client.beta.workflows.runs.retrieve(run.id);
      if (current.status === "succeeded") {
        completed = current;
        break;
      }
      if (["failed", "cancelled"].includes(current.status)) {
        throw new Error(`Workflow-Fehler: ${current.status}`);
      }
    }

    if (!completed?.output) {
      throw new Error("Keine Ausgabe vom Workflow erhalten.");
    }

    // Ausgabe normalisieren
    const output =
      typeof completed.output === "string"
        ? JSON.parse(completed.output)
        : completed.output;

    return NextResponse.json(output, { status: 200 });
  } catch (err: any) {
    console.error("❌ Agent-Fehler:", err);
    return NextResponse.json(
      { error: "Fehler beim AVV-Check", details: err.message ?? String(err) },
      { status: 500 }
    );
  }
}