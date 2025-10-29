// /lib/avvSchema.ts
export const AVV_RESPONSE_SCHEMA = {
  name: "avv_report",
  schema: {
    type: "object",
    properties: {
      contract_metadata: {
        type: "object",
        properties: {
          title: { type: "string" },
          date: { type: "string" },
          parties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["controller", "processor"] },
                name: { type: "string" },
                country: { type: "string" }
              },
              required: ["role", "name", "country"],
              additionalProperties: false
            }
          }
        },
        required: ["title", "date", "parties"],
        additionalProperties: false
      },
      findings: {
        type: "object",
        properties: {
          art_28: {
            type: "object",
            properties: clauseMap([
              "instructions_only","confidentiality","security_TOMs","subprocessors",
              "data_subject_rights_support","breach_support","deletion_return","audit_rights"
            ]),
            required: [
              "instructions_only","confidentiality","security_TOMs","subprocessors",
              "data_subject_rights_support","breach_support","deletion_return","audit_rights"
            ],
            additionalProperties: false
          },
          additional_clauses: {
            type: "object",
            properties: {
              international_transfers: clause(),
              liability_cap: presenceClause(),
              jurisdiction: presenceClause()
            },
            required: ["international_transfers","liability_cap","jurisdiction"],
            additionalProperties: false
          }
        },
        required: ["art_28","additional_clauses"],
        additionalProperties: false
      },
      risk_score: {
        type: "object",
        properties: {
          overall: { type: "number" },
          rationale: { type: "string" }
        },
        required: ["overall","rationale"],
        additionalProperties: false
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["high","medium","low"] },
            issue: { type: "string" },
            suggested_clause: { type: "string" }
          },
          required: ["severity","issue","suggested_clause"],
          additionalProperties: false
        }
      }
    },
    required: ["contract_metadata","findings","risk_score","actions"],
    additionalProperties: false
  },
  strict: true
};

function clause() {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: ["met","partial","missing"] },
      evidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            quote: { type: "string" },
            page: { type: "integer" }
          },
          required: ["quote","page"],
          additionalProperties: false
        }
      }
    },
    required: ["status","evidence"],
    additionalProperties: false
  };
}

function presenceClause() {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: ["present","not_found","met","partial","missing"] },
      evidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            quote: { type: "string" },
            page: { type: "integer" }
          },
          required: ["quote","page"],
          additionalProperties: false
        }
      }
    },
    required: ["status","evidence"],
    additionalProperties: false
  };
}

function clauseMap(keys: string[]) {
  const o: Record<string, any> = {};
  for (const k of keys) o[k] = clause();
  return o;
}
