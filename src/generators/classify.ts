import { callClaudeText } from "../api/client";
import { EXERCISE_TYPES, type ExerciseType } from "../types/exercises";

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
