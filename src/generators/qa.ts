import { callClaudeTool, getRelay, TITLE_HINT } from "../api/client";

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

/**
 * Threshold for the bidirectional NLI vote. A pair is "correct" when at least
 * one direction's entailment exceeds this AND neither direction's contradiction
 * exceeds {@link NLI_CONTRADICTION_GUARD}. Tuned conservatively at 0.5 so the
 * model errs toward the appeal pathway (Claude Opus) rather than auto-marking.
 */
const NLI_ENTAILMENT_THRESHOLD = 0.5;
const NLI_CONTRADICTION_GUARD = 0.5;

export async function markAnswer(
  question: string,
  correctAnswer: string,
  userAnswer: string,
  apiKey: string,
  model: string,
): Promise<boolean> {
  // Prefer HF cross-encoder NLI when available. Marking is latency-critical
  // (user is waiting after typing an answer) and the task is textbook NLI:
  // does one answer entail the other? We check both directions to be lenient
  // on partial answers and verbose answers alike, but flag any direction that
  // looks like an outright contradiction.
  const relay = getRelay();
  if (relay?.isHFConfigured?.() && correctAnswer && userAnswer) {
    try {
      const [forward, backward] = await Promise.all([
        relay.nli(userAnswer, correctAnswer, { callerId: "iris-cards:mark" }),
        relay.nli(correctAnswer, userAnswer, { callerId: "iris-cards:mark" }),
      ]);
      const contradiction = Math.max(forward.contradiction, backward.contradiction);
      if (contradiction > NLI_CONTRADICTION_GUARD) return false;
      const entailment = Math.max(forward.entailment, backward.entailment);
      return entailment > NLI_ENTAILMENT_THRESHOLD;
    } catch (err) {
      console.warn("iris-cards: HF NLI marking failed; falling back to Claude", err);
      // fall through
    }
  }

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
