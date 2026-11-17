/**
 * Triage configuration: the labels a repository lets the agent choose from, the
 * duplicate rule, and the comments it may post.
 *
 * The action ships no vocabulary of its own — a repository decides its labels in
 * `.github/pi-triage.yml` — but a few requirements are not negotiable: `bug` must
 * be one of the type labels, the duplicate label must be named, and every label
 * the file mentions must exist in the repository. Violations fail before the
 * model is called, so a typo cannot silently drop a label.
 */

export type TriageLabelOption = {
  name: string;
  description: string;
};

export type TriageLabelGroup = {
  required: boolean;
  options: TriageLabelOption[];
};

export type TriageCommentTemplates = {
  onNewIssue: string;
  onOriginal: string;
};

export type TriageDuplicateRule = {
  label: string;
  confidence: number;
  candidates: number;
  includeComments: boolean;
  comment: TriageCommentTemplates;
};

export type TriageConfig = {
  labels: {
    type: TriageLabelGroup;
    priority: TriageLabelGroup;
    state?: TriageLabelGroup;
  };
  duplicate: TriageDuplicateRule;
};

export type TriageConfigProblem = {
  field: string;
  message: string;
};

/** Label every triage configuration must offer. */
export const REQUIRED_TYPE_LABEL = "bug";

/** Default name for the duplicate marker label. */
export const DEFAULT_DUPLICATE_LABEL = "duplicate";

/**
 * Labels the agent must never apply. `pi` is the default `label_trigger`, so a
 * run that added it would start another run.
 */
export const FORBIDDEN_LABELS = ["pi"];

export const DEFAULT_COMMENT_TEMPLATES: TriageCommentTemplates = {
  onNewIssue: `Possibly a duplicate of #{{number}} ({{state}}): {{reason}}

If this is the same problem, please continue in #{{number}} and close this one.`,
  onOriginal: "Raised again in #{{new_number}} ({{date}}).",
};

const DEFAULTS = {
  confidence: 0.8,
  candidates: 8,
  includeComments: true,
};

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseGroup(
  raw: unknown,
  field: string,
  problems: TriageConfigProblem[],
  defaultRequired: boolean,
): TriageLabelGroup | undefined {
  const record = asRecord(raw);
  if (!record) {
    problems.push({ field, message: "group is missing" });
    return undefined;
  }

  const optionsRaw = Array.isArray(record.options) ? record.options : [];
  const options: TriageLabelOption[] = [];
  optionsRaw.forEach((entry, index) => {
    const option = asRecord(entry);
    const name = asString(option?.name)?.trim();
    if (!name) {
      problems.push({
        field: `${field}.options[${index}].name`,
        message: "label name is required",
      });
      return;
    }
    options.push({
      name,
      description: asString(option?.description)?.trim() ?? "",
    });
  });

  if (options.length === 0) {
    problems.push({ field: `${field}.options`, message: "needs at least one label" });
  }

  return { required: asBoolean(record.required, defaultRequired), options };
}

/**
 * Structural validation. Returns the normalized config plus every problem found;
 * callers must refuse to run when `problems` is not empty.
 */
export function validateTriageConfig(raw: unknown): {
  config?: TriageConfig;
  problems: TriageConfigProblem[];
} {
  const problems: TriageConfigProblem[] = [];
  const root = asRecord(raw);
  if (!root) {
    return {
      problems: [{ field: "", message: "config must be a mapping" }],
    };
  }

  const labels = asRecord(root.labels);
  if (!labels) {
    return {
      problems: [{ field: "labels", message: "section is missing" }],
    };
  }

  const type = parseGroup(labels.type, "labels.type", problems, true);
  const priority = parseGroup(labels.priority, "labels.priority", problems, true);
  const state = labels.state
    ? parseGroup(labels.state, "labels.state", problems, false)
    : undefined;

  // Policy: `bug` is not optional, whatever a repository otherwise chooses.
  if (type && !type.options.some((option) => option.name === REQUIRED_TYPE_LABEL)) {
    problems.push({
      field: "labels.type.options",
      message: `must contain "${REQUIRED_TYPE_LABEL}"`,
    });
  }

  const duplicateRaw = asRecord(root.duplicate);
  const duplicateLabel =
    asString(duplicateRaw?.label)?.trim() || DEFAULT_DUPLICATE_LABEL;
  if (duplicateRaw && asString(duplicateRaw.label)?.trim() === "") {
    problems.push({
      field: "duplicate.label",
      message: "must not be blank",
    });
  }

  const confidence = duplicateRaw?.confidence ?? DEFAULTS.confidence;
  if (
    typeof confidence !== "number" ||
    !(confidence > 0) ||
    confidence > 1
  ) {
    problems.push({
      field: "duplicate.confidence",
      message: "must be a number in (0, 1]",
    });
  }

  const candidates = duplicateRaw?.candidates ?? DEFAULTS.candidates;
  if (
    typeof candidates !== "number" ||
    !Number.isInteger(candidates) ||
    candidates < 1 ||
    candidates > 20
  ) {
    problems.push({
      field: "duplicate.candidates",
      message: "must be an integer in [1, 20]",
    });
  }

  const commentRaw = asRecord(duplicateRaw?.comment);
  const comment: TriageCommentTemplates = {
    onNewIssue:
      asString(commentRaw?.on_new_issue)?.trim() ||
      DEFAULT_COMMENT_TEMPLATES.onNewIssue,
    onOriginal:
      asString(commentRaw?.on_original)?.trim() ||
      DEFAULT_COMMENT_TEMPLATES.onOriginal,
  };

  // Unique names across every group plus the duplicate label.
  const seen = new Map<string, string>();
  const groups: Array<[string, TriageLabelGroup | undefined]> = [
    ["labels.type", type],
    ["labels.priority", priority],
    ["labels.state", state],
  ];
  for (const [field, group] of groups) {
    for (const option of group?.options ?? []) {
      const previous = seen.get(option.name);
      if (previous) {
        problems.push({
          field: `${field}.options`,
          message: `"${option.name}" is already defined in ${previous}`,
        });
      } else {
        seen.set(option.name, field);
      }
    }
  }
  if (seen.has(duplicateLabel)) {
    problems.push({
      field: "duplicate.label",
      message: `"${duplicateLabel}" is already used by ${seen.get(duplicateLabel)}`,
    });
  }

  for (const forbidden of FORBIDDEN_LABELS) {
    if (seen.has(forbidden) || duplicateLabel === forbidden) {
      problems.push({
        field: "labels",
        message: `"${forbidden}" cannot be applied automatically: it is the trigger label`,
      });
    }
  }

  if (problems.length > 0 || !type || !priority) {
    return { problems };
  }

  return {
    problems,
    config: {
      labels: { type, priority, ...(state ? { state } : {}) },
      duplicate: {
        label: duplicateLabel,
        confidence: confidence as number,
        candidates: candidates as number,
        includeComments: asBoolean(
          duplicateRaw?.include_comments,
          DEFAULTS.includeComments,
        ),
        comment,
      },
    },
  };
}

/** Every label the configuration expects the repository to define. */
export function configuredLabels(config: TriageConfig): string[] {
  const names = [
    ...config.labels.type.options.map((option) => option.name),
    ...config.labels.priority.options.map((option) => option.name),
    ...(config.labels.state?.options.map((option) => option.name) ?? []),
    config.duplicate.label,
  ];
  return [...new Set(names)];
}

/** Labels the configuration expects but the repository does not define. */
export function missingRepoLabels(
  config: TriageConfig,
  repoLabels: string[],
): string[] {
  const available = new Set(repoLabels.map((name) => name.toLowerCase()));
  return configuredLabels(config).filter(
    (name) => !available.has(name.toLowerCase()),
  );
}
