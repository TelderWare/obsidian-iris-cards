import { App, requestUrl } from "obsidian";
import { evaluateFormula } from "./safe-math";

// ─── Relay integration ─────────────────────────────────────────

let _app: App | undefined;
export function setRelayApp(app: App): void { _app = app; }

// ─── Shared API Helpers ─────────────────────────────────────────

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const TITLE_HINT =
  " The input may start with a parenthetical like (Context: Note Title, Section, Subsection) identifying the source topic and its heading hierarchy. Only reference this context in your output when the fact itself lacks enough context to be unambiguous — do not gratuitously name-drop it.";

function apiHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
  };
}

async function apiRequest(apiKey: string, body: object): Promise<Record<string, unknown>> {
  // Route through Iris Relay when available
  const relay = (_app as any)?.irisRelay;
  if (relay) return relay.request(body);

  try {
    const response = await requestUrl({
      url: API_URL,
      method: "POST",
      headers: apiHeaders(apiKey),
      body: JSON.stringify(body),
      throw: false,
    });
    if (response.status >= 400) {
      const msg = response.json?.error?.message ?? `API ${response.status}`;
      throw new Error(msg);
    }
    return response.json;
  } catch (e) {
    if (e instanceof Error) throw e;
    throw new Error(String(e));
  }
}

/** Call Claude with a tool and return the tool_use input block. */
async function callClaudeTool<T>(
  apiKey: string, model: string, system: string,
  content: string, tool: object, maxTokens: number,
): Promise<T> {
  const toolName = (tool as { name: string }).name;
  const json = await apiRequest(apiKey, {
    model, max_tokens: maxTokens, system,
    messages: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "tool", name: toolName },
  });
  const block = (json?.content as { type: string; input?: T }[] | undefined)?.find(
    (b) => b.type === "tool_use",
  );
  if (!block?.input) throw new Error("No tool response from Claude.");
  return block.input;
}

/** Call Claude and return the text response. */
async function callClaudeText(
  apiKey: string, model: string, system: string,
  content: string, maxTokens: number,
): Promise<string> {
  const json = await apiRequest(apiKey, {
    model, max_tokens: maxTokens, system,
    messages: [{ role: "user", content }],
  });
  return (json?.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
}

// ─── Quality Control (Standardizer) ─────────────────────────────

const QC_MODEL = "claude-opus-4-6";

const QC_PROMPT =
  "You are a flashcard quality controller. Given the source fact and a generated question+answer, verify and correct them.\n" +
  "1. Check that the question uses terminology correctly. The question must ask for exactly what the answer provides — if the answer is a drug class, the question must ask for the drug class, not the mechanism of action. If the answer is a definition, the question must ask for the definition, not an example. Fix any mismatch.\n" +
  "2. Check that the answer is factually correct against the source fact.\n" +
  "3. Remove answer leaks from the question.\n" +
  "4. Remove extraneous filler and gratuitous name-dropping of topic titles.\n" +
  "5. If the question is unsalvageable — nonsensical or tests nothing meaningful — set reject to true.";

const QC_TOOL = {
  name: "standardized",
  description: "Return the cleaned-up question and answer, or reject if unsalvageable.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The standardized question" },
      answer: { type: "string" as const, description: "The standardized answer" },
      reject: { type: "boolean" as const, description: "true if the question is unsalvageable and should be suspended" },
    },
    required: ["question", "answer"],
  },
};

export async function standardizeQuestion(
  fact: string, question: string, answer: string, apiKey: string,
): Promise<{ question: string; answer: string; reject?: boolean }> {
  const input = `Source fact:\n${fact}\n\nQuestion:\n${question}\n\nAnswer:\n${answer}`;
  return callClaudeTool<{ question: string; answer: string; reject?: boolean }>(
    apiKey, QC_MODEL, QC_PROMPT, input, QC_TOOL, 400,
  );
}

// ─── Types ──────────────────────────────────────────────────────

export const EXERCISE_TYPES = [
  "Q&A",
  "Multiple Choice",
  "Cloze",
  "True/False",
  "Solve Equation",
  "Assemble Equation",
  "Order Steps",
  "Correct the Mistake",
  "Explain Why",
] as const;

export type ExerciseType = (typeof EXERCISE_TYPES)[number];

/** Generation priority: cheap single-call types first, expensive/QC-pass types last. */
export const TYPE_PRIORITY: ExerciseType[] = [
  "Q&A",
  "Multiple Choice",
  "Cloze",
  "True/False",
  "Correct the Mistake",
  "Order Steps",
  "Assemble Equation",
  "Solve Equation",
  "Explain Why",        // QC pass doubles cost
];

export interface QAVariant {
  exerciseType: ExerciseType;
  question: string;
  answer: string;
  acceptedAnswers: string[];
  lastReviewed: string | null;
  suspended: boolean;
  recordMs: number | null;
}

export interface ParsedQA {
  body: string;
  eligibleTypes: ExerciseType[];
  variants: QAVariant[];
}

export function parseQABlock(fullContent: string): ParsedQA {
  const noFm = fullContent.replace(/^---[\s\S]*?---\n*/, "");
  const sepIdx = noFm.lastIndexOf("\n---\nQ: ");
  // Also check for blocks that start with Eligible: before any Q:
  const eligibleSepIdx = noFm.lastIndexOf("\n---\nEligible: ");
  const blockStart = eligibleSepIdx !== -1 ? Math.min(eligibleSepIdx, sepIdx === -1 ? Infinity : sepIdx) : sepIdx;

  if (blockStart === -1 || blockStart === Infinity) {
    return { body: noFm.trim(), eligibleTypes: [], variants: [] };
  }

  const body = noFm.slice(0, blockStart).trim();
  const lines = noFm.slice(blockStart + 5).split("\n"); // skip "\n---\n"

  let eligibleTypes: ExerciseType[] = [];
  const variants: QAVariant[] = [];
  let type: ExerciseType = "Q&A";
  let q = "";
  let a = "";
  let accepted: string[] = [];
  let reviewed: string | null = null;
  let suspended = false;
  let recordMs: number | null = null;

  const exerciseSet = new Set<string>(EXERCISE_TYPES);

  const pushVariant = () => {
    if (q && a) variants.push({ exerciseType: type, question: q, answer: a, acceptedAnswers: accepted, lastReviewed: reviewed, suspended, recordMs });
  };

  for (const line of lines) {
    if (line.startsWith("Eligible: ")) {
      eligibleTypes = line.slice(10).split(",").map(s => s.trim()).filter((s): s is ExerciseType => exerciseSet.has(s));
    } else if (line.startsWith("Q: ")) {
      pushVariant();
      q = line.slice(3).trim();
      a = "";
      type = "Q&A";
      accepted = [];
      reviewed = null;
      suspended = false;
      recordMs = null;
    } else if (line.startsWith("A: ")) {
      a = line.slice(3).trim();
    } else if (line.startsWith("Type: ")) {
      const val = line.slice(6).trim();
      if (exerciseSet.has(val)) type = val as ExerciseType;
    } else if (line.startsWith("Also accepted: ")) {
      accepted = line.slice(15).split(" | ").map(s => s.trim()).filter(Boolean);
    } else if (line.startsWith("Reviewed: ")) {
      reviewed = line.slice(10).trim() || null;
    } else if (line.startsWith("Suspended: ")) {
      suspended = line.slice(11).trim() === "true";
    } else if (line.startsWith("Record: ")) {
      const val = parseInt(line.slice(8).trim(), 10);
      if (!isNaN(val)) recordMs = val;
    } else if (q && !a && line.length > 0) {
      // Continuation of a multi-line question (e.g. MC options)
      q += "\n" + line;
    }
  }
  pushVariant();

  return { body, eligibleTypes, variants };
}

export function buildQABlock(variants: QAVariant[], eligibleTypes: ExerciseType[] = []): string {
  if (variants.length === 0 && eligibleTypes.length === 0) return "";
  const entries = variants.map(v => {
    let entry = `Q: ${v.question}\nA: ${v.answer}`;
    if (v.exerciseType !== "Q&A") {
      entry += `\nType: ${v.exerciseType}`;
    }
    if (v.acceptedAnswers.length > 0) {
      entry += `\nAlso accepted: ${v.acceptedAnswers.join(" | ")}`;
    }
    if (v.lastReviewed) {
      entry += `\nReviewed: ${v.lastReviewed}`;
    }
    if (v.suspended) {
      entry += `\nSuspended: true`;
    }
    if (v.recordMs != null) {
      entry += `\nRecord: ${v.recordMs}`;
    }
    return entry;
  });
  const eligibleLine = eligibleTypes.length > 0 ? `Eligible: ${eligibleTypes.join(", ")}\n\n` : "";
  return "\n\n---\n" + eligibleLine + entries.join("\n\n") + "\n";
}

export function stripQABlock(fullContent: string): string {
  // Strip frontmatter before searching so we don't accidentally match inside it
  const fmMatch = fullContent.match(/^---[\s\S]*?---\n*/);
  const fmLength = fmMatch ? fmMatch[0].length : 0;
  const body = fullContent.slice(fmLength);
  const qIdx = body.lastIndexOf("\n---\nQ: ");
  const eIdx = body.lastIndexOf("\n---\nEligible: ");
  const idx = eIdx !== -1 ? Math.min(eIdx, qIdx === -1 ? Infinity : qIdx) : qIdx;
  if (idx === -1 || idx === Infinity) return fullContent;
  return fullContent.slice(0, fmLength + idx);
}

const CLASSIFY_PROMPT = `You are an exercise-type classifier for a study tool. Given a fact, determine which exercise types can be meaningfully generated from it. Do not force eligibility — if the result would feel contrived or low-value, exclude the type.
## Exercise Types
### Q&A
Standard question-and-answer.
- Always eligible.
### Multiple Choice
Question with one correct answer and plausible distractors.
- Eligible when: the fact has a specific answer that belongs to a family of similar alternatives (e.g., names, values, categories, structures). Distractors must be genuinely plausible, not obviously wrong.
- Ineligible when: the fact is so niche that wrong answers would be arbitrary or misleading.
### Cloze
The fact restated with a key term or value blanked out.
- Eligible when: the fact contains at least one specific term, name, value, or phrase whose removal creates a meaningful gap.
- Ineligible when: the fact is too short, or blanking any part leaves an ambiguous or trivially guessable sentence.
### True/False
A statement the learner judges as true or false.
- Eligible when: the fact contains relationships, properties, or conditions that can be plausibly distorted into a false statement that tests understanding — not just swapping a name.
- Ineligible when: the only way to make it false is to replace a term with an arbitrary wrong one.
### Solve Equation
A problem requiring the learner to use a quantitative or mathematical relationship to compute an answer.
- Eligible when: the fact contains an equation, formula, or quantitative relationship with variables that can be assigned concrete values.
- Ineligible when: the fact is purely qualitative, or the equation is trivial.
### Order Steps
Arrange steps of a process in the correct sequence.
- Eligible when: the fact describes or implies a sequential process with 3 or more discrete, reorderable steps.
- Ineligible when: the fact mentions a process but only 1-2 steps, or the order is trivially obvious.
### Correct the Mistake
A version of the fact with a plausible error introduced; the learner identifies and fixes it.
- Eligible when: the fact has enough internal structure (relationships, values, terminology, directionality) that a specific, believable error can be inserted.
- Ineligible when: the fact is a simple label or name where the only possible mistake is substituting a random wrong word.
### Assemble Equation
The equation is shown with one term blanked out; the learner fills in the missing piece.
- Eligible when: the fact contains a named equation or formula with at least two distinct variables or constants.
- Ineligible when: the fact is purely qualitative, or the equation has only one term.
### Explain Why
A question asking the learner to explain the causal or mechanistic reason behind the fact.
- Eligible when: there is a genuine reason — mechanistic, logical, evolutionary, physical — behind the fact that a learner should understand.
- Ineligible when: the fact is a convention, arbitrary label, or definition with no underlying why.
## Input
A single fact.
## Output
Return ONLY a markdown list of eligible exercise types. No explanations, no reasoning, no extra text.
Example output:
- Q&A
- Multiple Choice
- Cloze
- Correct the Mistake`;

const exerciseSet = new Set<string>(EXERCISE_TYPES);

export async function classifyEligibility(
  body: string,
  apiKey: string,
  model: string,
): Promise<ExerciseType[]> {
  const text = await callClaudeText(apiKey, model, CLASSIFY_PROMPT, body, 200);
  const types: ExerciseType[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^-\s+(.+)$/);
    if (match) {
      const name = match[1].trim();
      if (exerciseSet.has(name)) types.push(name as ExerciseType);
    }
  }
  if (!types.includes("Q&A")) types.unshift("Q&A");
  return types;
}

// ─── Multiple Choice ────────────────────────────────────────────

const MC_PROMPT =
  "You are an exercise generator. Given a fact, generate exactly one multiple choice question with 4 options labeled A-D. Exactly one option must be correct. The three distractors must be plausible — they should be the same kind of thing as the correct answer (e.g., if the answer is an enzyme, the distractors should be enzymes). Avoid joke answers, obviously wrong options, and \"all of the above.\" Name the specific subject in the question to anchor it." + TITLE_HINT;

const MC_TOOL = {
  name: "multiple_choice",
  description: "Return a multiple choice question with four options and the correct answer letter.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The question stem" },
      A: { type: "string" as const, description: "Option A" },
      B: { type: "string" as const, description: "Option B" },
      C: { type: "string" as const, description: "Option C" },
      D: { type: "string" as const, description: "Option D" },
      correct: { type: "string" as const, description: "The correct letter (A, B, C, or D)" },
    },
    required: ["question", "A", "B", "C", "D", "correct"],
  },
};

export interface MCResult {
  question: string;
  options: { letter: string; text: string }[];
  correct: string;
}

export async function generateMultipleChoice(
  content: string,
  apiKey: string,
  model: string,
): Promise<MCResult> {
  const r = await callClaudeTool<{ question: string; A: string; B: string; C: string; D: string; correct: string }>(
    apiKey, model, MC_PROMPT, content, MC_TOOL, 400,
  );
  return {
    question: r.question ?? "Could not generate question.",
    options: ["A", "B", "C", "D"].map(l => ({ letter: l, text: r[l as "A" | "B" | "C" | "D"] ?? "" })),
    correct: (r.correct ?? "A").toUpperCase(),
  };
}

/** Encode an MC question into Q/A fields for storage. */
export function encodeMC(mc: MCResult): { question: string; answer: string } {
  const opts = mc.options.map(o => `${o.letter}. ${o.text}`).join("\n");
  return {
    question: `${mc.question}\n${opts}`,
    answer: mc.correct,
  };
}

/** Decode stored MC fields back into structured data. */
export function decodeMC(question: string, answer: string): MCResult {
  const lines = question.split("\n");
  const stem = lines[0];
  const options: { letter: string; text: string }[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^([A-D])\.\s+(.+)$/);
    if (m) options.push({ letter: m[1], text: m[2] });
  }
  return { question: stem, options, correct: answer };
}

// ─── Cloze ─────────────────────────────────────────────────────

const CLOZE_PROMPT =
  "You are an exercise generator. Given a fact, restate it as a single sentence with the most important terms or values wrapped in asterisks. These are the parts the learner should recall. The surrounding sentence must make each blanked term unambiguous. Do not wrap filler words, adjectives, or context that merely sets up the sentence." + TITLE_HINT;

const CLOZE_TOOL = {
  name: "cloze",
  description: "Return a single sentence with key terms wrapped in asterisks.",
  input_schema: {
    type: "object" as const,
    properties: {
      sentence: { type: "string" as const, description: "The sentence with *key terms* wrapped in asterisks" },
    },
    required: ["sentence"],
  },
};

export async function generateCloze(
  content: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const r = await callClaudeTool<{ sentence: string }>(apiKey, model, CLOZE_PROMPT, content, CLOZE_TOOL, 300);
  if (!r.sentence) throw new Error("No tool response from Claude.");
  return r.sentence;
}

/** Extract all *starred* terms from a cloze sentence. */
export function parseClozeTerms(sentence: string): string[] {
  const matches = sentence.match(/\*([^*]+)\*/g);
  if (!matches) return [];
  return matches.map(m => m.slice(1, -1));
}

/** Replace the nth *starred* term with a blank placeholder. */
export function occludeCloze(sentence: string, index: number): { display: string; answer: string } {
  const terms = parseClozeTerms(sentence);
  if (index < 0 || index >= terms.length) throw new Error("Cloze index out of range");
  const answer = terms[index];
  let i = 0;
  const display = sentence.replace(/\*([^*]+)\*/g, (_, term) => {
    if (i++ === index) return "___";
    return term;
  });
  return { display, answer };
}

// ─── True/False ─────────────────────────────────────────────────

const TRUE_FALSE_PROMPT =
  "You are an exercise generator. Given a fact, generate exactly one true/false statement. The statement should be false approximately half the time. When generating a false statement, distort a specific relationship, property, direction, or value — not just swap a name for a random wrong one. The distortion should be plausible enough that someone with shallow understanding might believe it. State whether the answer is true or false." + TITLE_HINT;

const TRUE_FALSE_TOOL = {
  name: "true_false",
  description: "Return a statement and whether it is true or false.",
  input_schema: {
    type: "object" as const,
    properties: {
      statement: { type: "string" as const, description: "The true/false statement" },
      answer: { type: "string" as const, enum: ["True", "False"], description: "Whether the statement is true or false" },
    },
    required: ["statement", "answer"],
  },
};

export async function generateTrueFalse(
  content: string,
  apiKey: string,
  model: string,
): Promise<{ statement: string; answer: string }> {
  const r = await callClaudeTool<{ statement: string; answer: string }>(
    apiKey, model, TRUE_FALSE_PROMPT, content, TRUE_FALSE_TOOL, 300,
  );
  return { statement: r.statement ?? "", answer: r.answer === "False" ? "False" : "True" };
}

// ─── Assemble Equation ──────────────────────────────────────────

const ASSEMBLE_EQUATION_PROMPT =
  "You are an exercise generator. Given a fact containing an equation or formula, return the name of the equation and the equation itself. Wrap every variable, constant, and operator group in the equation with asterisks so they can be individually blanked out. For example: *F* = *m* × *a*, or *E* = *m* × *c²*. Each asterisk-wrapped piece should be a single meaningful term the learner could be asked to recall." + TITLE_HINT;

const ASSEMBLE_EQUATION_TOOL = {
  name: "assemble_equation",
  description: "Return the equation name and the equation with key terms wrapped in asterisks.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string" as const, description: "Name of the equation (e.g. 'Newton\\'s Second Law')" },
      equation: { type: "string" as const, description: "The equation with each variable/constant wrapped in asterisks, e.g. '*F* = *m* × *a*'" },
    },
    required: ["title", "equation"],
  },
};

export async function generateAssembleEquation(
  content: string,
  apiKey: string,
  model: string,
): Promise<{ title: string; equation: string }> {
  const r = await callClaudeTool<{ title: string; equation: string }>(
    apiKey, model, ASSEMBLE_EQUATION_PROMPT, content, ASSEMBLE_EQUATION_TOOL, 300,
  );
  return { title: r.title ?? "", equation: r.equation ?? "" };
}

/** Encode Assemble Equation into Q/A fields. Q = title, A = equation with *terms*. */
export function encodeAssembleEquation(ae: { title: string; equation: string }): { question: string; answer: string } {
  return { question: ae.title, answer: ae.equation };
}

// ─── Explain Why ────────────────────────────────────────────────

const EXPLAIN_WHY_PROMPT =
  "You are an exercise generator. Given a fact, generate exactly one question asking the learner to explain the causal or mechanistic reason behind it. The question should not be answerable by restating the fact — it must require understanding of the underlying mechanism. Provide a model answer." + TITLE_HINT;

const EXPLAIN_WHY_TOOL = {
  name: "explain_why",
  description: "Return a why-question and a model answer explaining the mechanism.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "A question asking why or how the fact is the case" },
      answer: { type: "string" as const, description: "A model answer explaining the causal or mechanistic reason" },
    },
    required: ["question", "answer"],
  },
};

export async function generateExplainWhy(
  content: string,
  apiKey: string,
  model: string,
): Promise<{ question: string; answer: string }> {
  const r = await callClaudeTool<{ question: string; answer: string }>(
    apiKey, model, EXPLAIN_WHY_PROMPT, content, EXPLAIN_WHY_TOOL, 400,
  );
  return { question: r.question ?? "Could not generate question.", answer: r.answer ?? "Could not generate answer." };
}

// ─── Correct the Mistake ────────────────────────────────────────

const CORRECT_MISTAKE_PROMPT =
  "You are an exercise generator. Given a fact, restate it with exactly one plausible error introduced. The error should distort a specific relationship, value, direction, or term — not just swap a name randomly. Provide the incorrect statement and the corrected statement separately." + TITLE_HINT;

const CORRECT_MISTAKE_TOOL = {
  name: "correct_mistake",
  description: "Return an incorrect version of the fact and the corrected version.",
  input_schema: {
    type: "object" as const,
    properties: {
      incorrect: { type: "string" as const, description: "The statement with one plausible error introduced" },
      corrected: { type: "string" as const, description: "The corrected statement with the error fixed" },
    },
    required: ["incorrect", "corrected"],
  },
};

export interface CorrectMistakeResult {
  incorrect: string;
  corrected: string;
}

export async function generateCorrectMistake(
  content: string,
  apiKey: string,
  model: string,
): Promise<CorrectMistakeResult> {
  const r = await callClaudeTool<{ incorrect: string; corrected: string }>(
    apiKey, model, CORRECT_MISTAKE_PROMPT, content, CORRECT_MISTAKE_TOOL, 400,
  );
  return { incorrect: r.incorrect ?? "", corrected: r.corrected ?? "" };
}

// ─── Order Steps ────────────────────────────────────────────────

const ORDER_STEPS_PROMPT =
  "You are an exercise generator. Given a fact describing a sequential process, list the steps in the correct order as numbered steps. Each step should be a short, standalone phrase. CRITICAL: Steps will be shown in random order for the learner to sort, so each step must NOT leak its position — never use sequencing words like 'first', 'then', 'next', 'finally', 'after that', 'subsequently', or anaphoric references like 'do this', 'transfer each one', 'repeat the above'. Each step must be fully self-contained." + TITLE_HINT;

const ORDER_STEPS_TOOL = {
  name: "order_steps",
  description: "Return the steps of a process in the correct order.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string" as const, description: "Short title describing the process" },
      steps: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Steps in the correct order, each a short phrase",
      },
    },
    required: ["title", "steps"],
  },
};

export interface OrderStepsResult {
  title: string;
  steps: string[];
}

export async function generateOrderSteps(
  content: string,
  apiKey: string,
  model: string,
): Promise<OrderStepsResult> {
  const r = await callClaudeTool<{ title: string; steps: string[] }>(
    apiKey, model, ORDER_STEPS_PROMPT, content, ORDER_STEPS_TOOL, 400,
  );
  return { title: r.title ?? "", steps: r.steps ?? [] };
}

/** Encode Order Steps into Q/A fields. Q = title, A = JSON array of steps in correct order. */
export function encodeOrderSteps(os: OrderStepsResult): { question: string; answer: string } {
  return { question: os.title, answer: JSON.stringify(os.steps) };
}

/** Decode stored Order Steps fields. */
export function decodeOrderSteps(question: string, answer: string): OrderStepsResult {
  let steps: string[];
  try { steps = JSON.parse(answer); } catch { throw new Error("Invalid order-steps JSON"); }
  if (!Array.isArray(steps)) throw new Error("Order-steps answer is not an array");
  return { title: question, steps };
}

/** Shuffle an array (Fisher-Yates), returns a new array. */
export function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Solve Equation ─────────────────────────────────────────────

const SOLVE_EQUATION_PROMPT =
  "You are an exercise generator. Given a fact containing an equation or quantitative relationship, generate a problem template. Describe a scenario that requires the learner to identify and apply the correct equation. Define each known variable with a name, a realistic range (min and max), units, and number of significant figures. Specify which variable the learner must solve for. Do not name or provide the equation in the scenario." + TITLE_HINT;

const SOLVE_EQUATION_TOOL = {
  name: "solve_equation",
  description: "Return a problem template with a scenario, known variables with ranges, a target variable, and a formula for internal validation.",
  input_schema: {
    type: "object" as const,
    properties: {
      scenario: { type: "string" as const, description: "Problem description. Do not mention the equation name or formula." },
      knowns: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const, description: "Human-readable name (e.g. 'mass')" },
            symbol: { type: "string" as const, description: "Short variable symbol (e.g. 'm')" },
            min: { type: "number" as const, description: "Minimum realistic value" },
            max: { type: "number" as const, description: "Maximum realistic value" },
            units: { type: "string" as const, description: "Units (e.g. 'kg', 'm/s')" },
            sigfigs: { type: "number" as const, description: "Number of significant figures" },
          },
          required: ["name", "symbol", "min", "max", "units", "sigfigs"],
        },
        description: "Known variables the learner is given",
      },
      target: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Human-readable name of the variable to solve for" },
          symbol: { type: "string" as const, description: "Short variable symbol" },
          units: { type: "string" as const, description: "Units of the answer" },
          sigfigs: { type: "number" as const, description: "Number of significant figures for the answer" },
        },
        required: ["name", "symbol", "units", "sigfigs"],
      },
      formula: {
        type: "string" as const,
        description: "JavaScript expression using ONLY the known variable symbols that computes the target value. E.g. 'm * a' when solving for F. Use Math.sqrt(), Math.pow(), Math.PI, Math.log() for advanced operations. Not shown to learner.",
      },
    },
    required: ["scenario", "knowns", "target", "formula"],
  },
};

export interface SolveEquationKnown {
  name: string;
  symbol: string;
  min: number;
  max: number;
  units: string;
  sigfigs: number;
}

export interface SolveEquationTarget {
  name: string;
  symbol: string;
  units: string;
  sigfigs: number;
}

export interface SolveEquationResult {
  scenario: string;
  knowns: SolveEquationKnown[];
  target: SolveEquationTarget;
  formula: string;
}

export async function generateSolveEquation(
  content: string,
  apiKey: string,
  model: string,
): Promise<SolveEquationResult> {
  const r = await callClaudeTool<SolveEquationResult>(
    apiKey, model, SOLVE_EQUATION_PROMPT, content, SOLVE_EQUATION_TOOL, 600,
  );
  return {
    scenario: r.scenario ?? "",
    knowns: r.knowns ?? [],
    target: r.target ?? { name: "", symbol: "", units: "", sigfigs: 3 },
    formula: r.formula ?? "",
  };
}

/** Encode a Solve Equation problem into Q/A fields for storage. */
export function encodeSolveEquation(se: SolveEquationResult): { question: string; answer: string } {
  const { formula, ...display } = se;
  return {
    question: JSON.stringify(display),
    answer: formula,
  };
}

/** Decode stored Solve Equation fields back into structured data. */
export function decodeSolveEquation(question: string, answer: string): SolveEquationResult {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(question); } catch { throw new Error("Invalid solve-equation JSON"); }
  return { ...parsed, formula: answer } as SolveEquationResult;
}

/** Round a number to N significant figures. */
export function roundToSigFigs(num: number, sigfigs: number): number {
  if (num === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(num)));
  const power = sigfigs - d;
  const magnitude = Math.pow(10, power);
  return Math.round(num * magnitude) / magnitude;
}

/** Generate concrete values for known variables within their ranges. */
export function randomizeKnowns(knowns: SolveEquationKnown[]): Record<string, number> {
  const values: Record<string, number> = {};
  for (const k of knowns) {
    const raw = k.min + Math.random() * (k.max - k.min);
    values[k.symbol] = roundToSigFigs(raw, k.sigfigs);
  }
  return values;
}

// evaluateFormula is imported from safe-math.ts (recursive descent parser, no Function constructor)
export { evaluateFormula } from "./safe-math";

/** Check if a user's numerical answer matches the expected value within sig-fig tolerance. */
export function checkNumericalAnswer(userAnswer: number, expected: number, sigfigs: number): boolean {
  const rounded = roundToSigFigs(expected, sigfigs);
  if (rounded === 0) return Math.abs(userAnswer) < 0.01;
  const relError = Math.abs(userAnswer - rounded) / Math.abs(rounded);
  return relError < 0.02;
}

// ─── Q&A ───────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a flashcard generator. Given some information, generate exactly one question and one concise answer that tests recall. Name the specific subject in the question to anchor it. The answer must not be extractable from the question." + TITLE_HINT;

const QA_TOOL = {
  name: "flashcard",
  description: "Return a single flashcard question and answer.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The question to test recall" },
      answer: { type: "string" as const, description: "The concise answer" },
    },
    required: ["question", "answer"],
  },
};

export async function generateQA(
  content: string,
  apiKey: string,
  model: string,
): Promise<{ question: string; answer: string }> {
  const r = await callClaudeTool<{ question: string; answer: string }>(
    apiKey, model, SYSTEM_PROMPT, content, QA_TOOL, 300,
  );
  return { question: r.question ?? "Could not generate question.", answer: r.answer ?? "Could not generate answer." };
}

const VARIANT_PROMPT =
  "You are a flashcard generator. Given a question and answer, generate one alternate question that tests the same knowledge from a different angle. The alternate should approach the material from the opposite direction or reframe it. The answer should be concise.";

const VARIANT_TOOL = {
  name: "alternate",
  description: "Return one alternate flashcard question and answer.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The alternate question" },
      answer: { type: "string" as const, description: "The concise answer" },
    },
    required: ["question", "answer"],
  },
};

export async function generateVariant(
  question: string,
  answer: string,
  apiKey: string,
  model: string,
): Promise<{ question: string; answer: string }> {
  const r = await callClaudeTool<{ question: string; answer: string }>(
    apiKey, model, VARIANT_PROMPT, `Question: ${question}\nAnswer: ${answer}`, VARIANT_TOOL, 300,
  );
  return { question: r.question ?? "Could not generate question.", answer: r.answer ?? "Could not generate answer." };
}

const JUDGE_PROMPT =
  "You are a flashcard reviewer. Given a question, the correct answer, and the user's answer, judge whether the user's answer is factually correct. Be lenient with phrasing and synonyms, but strict on factual accuracy — a wrong fact is wrong even if it sounds similar. For example, 'the hunt' and 'hunting' are the same concept (correct), but 'Ares' is not 'Artemis' (incorrect).";

const JUDGE_TOOL = {
  name: "judgment",
  description: "Return whether the user's answer is correct.",
  input_schema: {
    type: "object" as const,
    properties: {
      correct: { type: "boolean" as const, description: "Whether the user's answer demonstrates knowledge of the material" },
    },
    required: ["correct"],
  },
};

export async function markAnswer(
  question: string,
  correctAnswer: string,
  userAnswer: string,
  apiKey: string,
  model: string,
): Promise<boolean> {
  const r = await callClaudeTool<{ correct: boolean }>(
    apiKey, model, JUDGE_PROMPT,
    `Question: ${question}\nCorrect answer: ${correctAnswer}\nUser's answer: ${userAnswer}`,
    JUDGE_TOOL, 100,
  );
  return r.correct ?? false;
}

const APPEAL_PROMPT =
  "You are a flashcard reviewer. The user was asked a question and gave an answer. Judge whether the user's answer is factually correct for the question asked. Be lenient with phrasing, synonyms, and partial answers — if the user clearly knows the material, mark it correct.";

const APPEAL_MODEL = "claude-opus-4-6";

export async function appealAnswer(
  question: string,
  userAnswer: string,
  apiKey: string,
): Promise<boolean> {
  const r = await callClaudeTool<{ correct: boolean }>(
    apiKey, APPEAL_MODEL, APPEAL_PROMPT,
    `Question: ${question}\nUser's answer: ${userAnswer}`,
    JUDGE_TOOL, 100,
  );
  return r.correct ?? false;
}

// ─── Fact Extraction ────────────────────────────────────────────

const EXTRACT_PROMPT =
  "You are a fact extractor for spaced repetition flashcards. Given a note, identify every discrete, testable piece of knowledge by returning verbatim excerpts from the source text. " +
  "Each excerpt must be copied exactly as it appears — do not rephrase, summarize, or combine. " +
  "Each excerpt should be a self-contained, atomic fact (one concept). " +
  "Skip headings, metadata, navigation text, and prose that doesn't contain testable knowledge.";

const EXTRACT_TOOL = {
  name: "extract_facts",
  description: "Extract verbatim testable facts from a note.",
  input_schema: {
    type: "object" as const,
    properties: {
      facts: {
        type: "array" as const,
        items: { type: "string" as const, description: "Verbatim excerpt from the note" },
      },
    },
    required: ["facts"],
  },
};

export async function extractFactsFromNote(
  content: string, apiKey: string, model: string,
): Promise<string[]> {
  const r = await callClaudeTool<{ facts: string[] }>(
    apiKey, model, EXTRACT_PROMPT, content, EXTRACT_TOOL, 4096,
  );
  return Array.isArray(r.facts) ? r.facts.filter(f => typeof f === "string" && f.trim()) : [];
}
