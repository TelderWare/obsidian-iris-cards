export const EXERCISE_TYPES = [
  "Q&A",
  "Multiple Choice",
  "Cloze",
  "True/False",
  "Solve Equation",
  "Assemble Equation",
  "Order Steps",
  "Correct the Mistake",
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
];

export interface QAVariant {
  exerciseType: ExerciseType;
  question: string;
  answer: string;
  acceptedAnswers: string[];
  lastReviewed: string | null;
  suspended: boolean;
  recordMs: number | null;
  difficulty: number | null;
}

export interface ParsedQA {
  body: string;
  eligibleTypes: ExerciseType[];
  variants: QAVariant[];
}
