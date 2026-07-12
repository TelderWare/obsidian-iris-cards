export const EXERCISE_TYPES = [
  "Q&A",
  "Multiple Choice",
  "Cloze",
  "True/False",
  "List",
  "Solve Equation",
  "Assemble Equation",
  "Place in Order",
  "Correct the Mistake",
  "Image Occlusion",
  "Synonym",
  "Rank",
  "Word",
  "Pairs",
  "Multi-step",
] as const;

export type ExerciseType = (typeof EXERCISE_TYPES)[number];

export interface QAVariant {
  exerciseType: ExerciseType;
  question: string;
  answer: string;
  acceptedAnswers: string[];
  knownIncorrect: string[];
  lastReviewed: string | null;
  suspended: boolean;
  recordMs: number | null;
  difficulty: number | null;
  /**
   * Per-gap FSRS difficulty for cloze-style variants (canonical gap term →
   * difficulty). Lets the scheduler treat each gap of one cloze as its own
   * memory item: the reviewed gap's difficulty feeds the stability update and
   * harder gaps are occluded more often. Absent for single-answer types.
   */
  gapDifficulties?: Record<string, number>;
}

export interface ParsedQA {
  body: string;
  eligibleTypes: ExerciseType[];
  variants: QAVariant[];
}
