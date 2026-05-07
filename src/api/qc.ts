import { callClaudeTool } from "./client";

const QC_MODEL = "claude-opus-4-6";

const QC_PROMPT =
  "You are a flashcard quality controller. Given the source fact and a generated question+answer, verify and correct them.\n" +
  "1. Check that the question uses terminology correctly. The question must ask for exactly what the answer provides — if the answer is a drug class, the question must ask for the drug class, not the mechanism of action. If the answer is a definition, the question must ask for the definition, not an example. Fix any mismatch.\n" +
  "2. Check that the answer is factually correct and fully supported by the source fact. If the question asks for something the source fact does not contain, reject it.\n" +
  "3. Remove answer leaks from the question.\n" +
  "4. Remove extraneous filler and gratuitous name-dropping of topic titles.\n" +
  "5. Reject questions whose answer is a vague qualifier ('well-characterised', 'widespread', 'important', 'commonly') rather than a concrete fact. A good answer is a name, number, mechanism, or structure.\n" +
  "6. Keep the answer concise. If it reads like a paragraph wrapping a single fact, distill it to that point.\n" +
  "7. Reject (do not rewrite) answers that are fundamentally a list of multiple discrete items the learner must enumerate — e.g. 'the four humours: blood, phlegm, yellow bile, black bile'. These belong to a List exercise type, not Q&A. A single concept with elaboration is fine; multiple recall targets glued together is not.\n" +
  "8. If the question is unsalvageable — nonsensical, tests nothing meaningful, or not answerable from the source — set reject to true and give a brief reason.";

const QC_TOOL = {
  name: "standardized",
  description: "Return the cleaned-up question and answer, or reject if unsalvageable.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The standardized question" },
      answer: { type: "string" as const, description: "The standardized answer" },
      reject: { type: "boolean" as const, description: "true if the question is unsalvageable and should be suspended" },
      reject_reason: { type: "string" as const, description: "Brief reason for rejection (only when reject is true)" },
    },
    required: ["question", "answer"],
  },
};

export interface QCResult {
  question: string;
  answer: string;
  reject?: boolean;
  reject_reason?: string;
}

export async function standardizeQuestion(
  fact: string, question: string, answer: string, apiKey: string,
): Promise<QCResult> {
  const input = `Source fact:\n${fact}\n\nQuestion:\n${question}\n\nAnswer:\n${answer}`;
  return callClaudeTool<QCResult>(
    apiKey, QC_MODEL, QC_PROMPT, input, QC_TOOL, 400,
  );
}

const REFRAME_PROMPT =
  "You are a flashcard rescuer. A previous Q&A was rejected for the given reason. Reframe it: produce a NEW question and answer drawn from the same source fact that avoids the rejection reason. Pick a different angle — for a list-shaped rejection, focus on one specific item or property; for a vague-qualifier rejection, find a concrete fact; etc. The new Q&A must stand entirely on its own. If no salvageable angle exists, set abandon to true.";

const REFRAME_TOOL = {
  name: "reframe",
  description: "Return a reframed question and answer that addresses the rejection reason, or abandon.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The reframed question" },
      answer: { type: "string" as const, description: "The reframed answer" },
      abandon: { type: "boolean" as const, description: "true if no salvageable angle exists in the source fact" },
    },
    required: ["question", "answer"],
  },
};

export interface ReframeResult {
  question: string;
  answer: string;
  abandon?: boolean;
}

export async function reframeQuestion(
  fact: string,
  rejectedQuestion: string,
  rejectedAnswer: string,
  rejectReason: string,
  apiKey: string,
): Promise<ReframeResult> {
  const input =
    `Source fact:\n${fact}\n\n` +
    `Rejected question:\n${rejectedQuestion}\n\n` +
    `Rejected answer:\n${rejectedAnswer}\n\n` +
    `Rejection reason:\n${rejectReason}`;
  return callClaudeTool<ReframeResult>(
    apiKey, QC_MODEL, REFRAME_PROMPT, input, REFRAME_TOOL, 400,
  );
}
