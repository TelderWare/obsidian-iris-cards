import type { App } from "obsidian";

const IRIS_TASKS_PLUGIN_ID = "iris-tasks";
const TASK_ID = "ext-iris-cards-review";
const CLICK_COMMAND = "iris-cards:open-review";
const REVIEW_VIEW_TYPE = "iris-cards-review";

interface IrisTasksApi {
  upsertExternalTask(req: {
    id: string;
    title: string;
    onClickCommand?: string;
    viewType?: string;
    autoCompletes?: boolean;
    durationMin?: number | null;
  }): Promise<string>;
  completeExternalTask(id: string): Promise<void>;
}

function getTasksApi(app: App): IrisTasksApi | null {
  const plugins = (app as unknown as {
    plugins?: { plugins?: Record<string, unknown> };
  }).plugins?.plugins;
  const plugin = plugins?.[IRIS_TASKS_PLUGIN_ID] as IrisTasksApi | undefined;
  if (!plugin || typeof plugin.upsertExternalTask !== "function") return null;
  return plugin;
}

export function syncFlashcardTask(app: App, dueCount: number, durationMin?: number): void {
  const api = getTasksApi(app);
  if (!api) return;
  if (dueCount > 0) {
    void api.upsertExternalTask({
      id: TASK_ID,
      title: "Flashcards",
      onClickCommand: CLICK_COMMAND,
      viewType: REVIEW_VIEW_TYPE,
      autoCompletes: true,
      durationMin: durationMin != null && durationMin > 0 ? durationMin : null,
    });
  } else {
    void api.completeExternalTask(TASK_ID);
  }
}
